import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";
import { join } from "node:path";
import { killTree, spawnDetached } from "@aibuildos/acp/reap";
import { parseOkfDocument } from "@aibuildos/knowledge-engine";
import { BrowserWindow, WebContentsView } from "electron";

/**
 * Previews (RQ-0025, DC-0012): the project's declared run command as a child server, rendered in a
 * `WebContentsView` main positions from the renderer's reported bounds.
 *
 * Declaration format: a ` ```run ` fence in any active playbook's body — same fence source as
 * `checks.ts`'s ` ```check `, same reasoning (not only a playbook titled for it; the record is asked
 * what it declares). Exactly two non-blank lines: the command on the first, the `http(s)://` URL it
 * serves on the second. Anything else — no fence, the wrong line count, a second line that is not a
 * URL — reads as "this project declares no way to run" (RQ-0025#AC-4), not an error. Only the
 * *first* well-formed fence found (playbooks read in filename order, same as `checks.ts`) is used —
 * one project, one preview, in v1.
 *
 * `parseOkfDocument` (knowledge-engine) stays the one frontmatter/body parser; this module only
 * extracts a fence from the body string it is handed.
 *
 * One preview at a time for the whole application (v1 — see `current` below): starting a new one
 * stops whatever was already running.
 */

export interface RunDeclaration {
  readonly command: string;
  readonly url: string;
}

const PLAYBOOK_FILE = /^pb-\d{4,}\.md$/i;
/** A fence's opening and closing markers are their own lines; `m` anchors each `^`/`$` to one (same
 * approach as `checks.ts`'s `CHECK_FENCE`). */
const RUN_FENCE = /^```run\n([\s\S]*?)\n```$/gm;

const READY_INTERVAL_MS = 250;
const READY_BUDGET_MS = 15_000;
/** Captured stdout/stderr kept for a failure message, newest last — enough to be legible, not a log. */
const OUTPUT_CAP = 4000;

/** The first well-formed `run` fence in one artifact body. Exported for its own test. */
export function extractRunDeclaration(body: string): RunDeclaration | null {
  for (const match of body.matchAll(RUN_FENCE)) {
    const lines = (match[1] ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
    if (lines.length !== 2) continue;
    const [command, url] = lines;
    if (command === undefined || url === undefined || !/^https?:\/\//.test(url)) continue;
    return { command, url };
  }
  return null;
}

/**
 * This project's run declaration, from the first active `Playbook` under `docs/playbooks/` (in
 * filename order) whose body carries a well-formed `run` fence. `null` when there is no playbooks
 * directory, no active playbook, or none with one — all three are "declares no way to run".
 */
function projectRunDeclaration(projectPath: string): RunDeclaration | null {
  const dir = join(projectPath, "docs", "playbooks");
  if (!existsSync(dir)) return null;

  for (const entry of readdirSync(dir).sort()) {
    if (!PLAYBOOK_FILE.test(entry)) continue;

    let parsed: ReturnType<typeof parseOkfDocument>;
    try {
      parsed = parseOkfDocument(readFileSync(join(dir, entry), "utf8"));
    } catch {
      // Same stance as `checks.ts`: an artifact that will not parse is `docs:check`'s complaint,
      // not this reader's — it contributes nothing rather than failing the lookup.
      continue;
    }

    if (parsed.frontmatter.type !== "Playbook" || parsed.frontmatter.state !== "active") continue;
    const declaration = extractRunDeclaration(parsed.body);
    if (declaration !== null) return declaration;
  }
  return null;
}

interface CurrentPreview {
  readonly child: ChildProcess;
  readonly window: InstanceType<typeof BrowserWindow> | null;
  readonly view: InstanceType<typeof WebContentsView> | null;
}

/** The one preview running, if any (see the module comment — only ever one). */
let current: CurrentPreview | null = null;

function stopCurrent(): void {
  if (current === null) return;
  const { child, window, view } = current;
  killTree(child);
  if (window !== null && view !== null) window.contentView.removeChildView(view);
  current = null;
}

/** Resolves `true` the moment `url` answers at all — any status code is "up", the bar DC-0012 sets
 * ("waits for its URL to answer"). */
function probe(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const get = url.startsWith("https://") ? httpsGet : httpGet;
    const request = get(url, (response) => {
      response.resume();
      resolve(true);
    });
    request.on("error", () => resolve(false));
    request.setTimeout(READY_INTERVAL_MS, () => request.destroy());
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Waits for `url` to answer, polling every `READY_INTERVAL_MS` up to `READY_BUDGET_MS`. Settles
 * early — failed — the instant the child exits or errors, with whatever it had printed as the
 * reason (RQ-0025#AC-3): a dead process is never worth polling further.
 */
function waitForReady(
  child: ChildProcess,
  url: string,
  command: string,
  tail: () => string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (result: { ok: true } | { ok: false; message: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(result);
    };

    const diedEarly = (): void =>
      done({ ok: false, message: tail().trim() || `\`${command}\` exited before answering.` });
    child.once("exit", diedEarly);
    child.once("error", diedEarly);

    const deadline = setTimeout(() => {
      const captured = tail().trim();
      done({
        ok: false,
        message: `\`${command}\` did not answer at ${url} within 15s.${captured === "" ? "" : `\n\n${captured}`}`,
      });
    }, READY_BUDGET_MS);

    void (async () => {
      while (!settled) {
        if (await probe(url)) {
          done({ ok: true });
          return;
        }
        await sleep(READY_INTERVAL_MS);
      }
    })();
  });
}

/**
 * Starts this project's declared preview: spawns the command, waits for its URL to answer, and
 * renders it in a `WebContentsView` added to the running application's window.
 *
 * The window is resolved lazily — `BrowserWindow.getAllWindows()[0]` — rather than wired in at
 * startup, mirroring how `index.ts` resolves the session sender and the menu's command target: it
 * tolerates the window being recreated while the app runs, and it is what lets this module resolve
 * (readiness, failure messages, teardown) without a real Electron runtime, which is how its own test
 * file exercises it under plain Vitest (AR-0002). No window simply means no view is attached; the
 * server itself still starts and is still torn down like any other.
 */
export async function startPreview(
  projectPath: string,
): Promise<{ ok: true; url: string } | { ok: false; message: string }> {
  const declaration = projectRunDeclaration(projectPath);
  if (declaration === null) {
    return {
      ok: false,
      message: "This project declares no way to run — no active playbook carries a `run` fence.",
    };
  }

  stopCurrent();

  const { command, url } = declaration;
  const child = spawn(command, {
    shell: true,
    cwd: projectPath,
    windowsHide: true,
    detached: spawnDetached,
  });
  let output = "";
  const capture = (chunk: Buffer): void => {
    output = (output + chunk.toString("utf8")).slice(-OUTPUT_CAP);
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);

  current = { child, window: null, view: null };

  const ready = await waitForReady(child, url, command, () => output);
  if (!ready.ok) {
    stopCurrent();
    return ready;
  }

  const window = typeof BrowserWindow === "function" ? BrowserWindow.getAllWindows()[0] : undefined;
  if (window !== undefined) {
    const view = new WebContentsView();
    window.contentView.addChildView(view);
    void view.webContents.loadURL(url);
    current = { child, window, view };
  }

  return { ok: true, url };
}

/** Stops whatever preview is running. `projectPath` is unused — v1 keeps one preview for the whole
 * application, not one per project (see the module comment) — kept in the signature only because
 * `preview:stop` is already shaped that way. */
export async function stopPreview(_projectPath: string): Promise<{ problem: string | null }> {
  stopCurrent();
  return { problem: null };
}

/** Where the preview's view sits, in window coordinates; zero size hides it without tearing it
 * down (that is `preview:stop`'s job) — rounded because `View#setBounds` wants integers and the
 * renderer reports a `DOMRect`, which does not. */
export function setPreviewBounds(bounds: {
  x: number;
  y: number;
  width: number;
  height: number;
}): void {
  if (current?.view == null) return;
  current.view.setBounds({
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height),
  });
}

/**
 * Kills whatever preview is running. Called from `before-quit` (mirrors `killChecks`) — closing the
 * window must not leave an orphaned dev server holding a port. Group kill via `reap.ts`: a dev
 * server is exactly the forking case where killing only the shell wrapper leaves the port held.
 */
export function killPreviews(): void {
  stopCurrent();
}
