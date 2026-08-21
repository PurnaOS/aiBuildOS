import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractRunDeclaration, killPreviews, startPreview, stopPreview } from "./previews.js";

/**
 * TC-0070. Fenced ` ```run ` declarations, extracted the same way `checks.test.ts` proves fences
 * are, then a real trivial server started and torn down as a real child process.
 *
 * No `electron` runtime here (AR-0002 — this suite runs on plain Node under Vitest): `previews.ts`
 * resolves the application window lazily and tolerates its absence, so `startPreview`/`stopPreview`
 * are exercised exactly as written, minus the `WebContentsView` that only a real window would get.
 */
describe("extracting a run declaration from a body", () => {
  it("takes the command and the URL from a well-formed two-line fence", () => {
    const body = ["# A playbook", "", "```run", "npx serve .", "http://localhost:3000", "```"].join(
      "\n",
    );
    expect(extractRunDeclaration(body)).toEqual({
      command: "npx serve .",
      url: "http://localhost:3000",
    });
  });

  it("rejects a fence with only a command and no URL", () => {
    expect(extractRunDeclaration(["```run", "npx serve .", "```"].join("\n"))).toBeNull();
  });

  it("rejects a fence with a third line", () => {
    const body = ["```run", "npx serve .", "http://localhost:3000", "extra", "```"].join("\n");
    expect(extractRunDeclaration(body)).toBeNull();
  });

  it("rejects a fence whose second line is not an http(s) URL", () => {
    const body = ["```run", "npx serve .", "localhost:3000", "```"].join("\n");
    expect(extractRunDeclaration(body)).toBeNull();
  });

  it("reports no declaration when there is no run fence at all", () => {
    expect(extractRunDeclaration("# A playbook\n\nNothing here.")).toBeNull();
  });

  it("takes the first fence when a body carries more than one", () => {
    const body = [
      "```run",
      "npx serve .",
      "http://localhost:3000",
      "```",
      "",
      "```run",
      "npx serve dist",
      "http://localhost:4000",
      "```",
    ].join("\n");
    expect(extractRunDeclaration(body)?.url).toBe("http://localhost:3000");
  });
});

/** A free TCP port: bind a throwaway server, close it, template the number into the fixture. A
 * small race (something else could grab it first) is the same ceiling `checks.test.ts`'s sibling
 * suites accept for anything port-based — nothing else in this codebase avoids it either. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : null;
      server.close(() => {
        if (port === null) reject(new Error("could not allocate a port"));
        else resolve(port);
      });
    });
    server.on("error", reject);
  });
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilDead(pid: number, timeoutMs = 4000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

/** Writes one active Playbook artifact whose body is exactly what's given. */
function writePlaybook(dir: string, id: string, state: string, body: string): void {
  const playbooksDir = join(dir, "docs", "playbooks");
  mkdirSync(playbooksDir, { recursive: true });
  writeFileSync(
    join(playbooksDir, `${id}.md`),
    `---\ntype: Playbook\nid: ${id.toUpperCase()}\ntitle: "Run it"\nstate: ${state}\n` +
      `owner: test\nprovenance: agent\ncreated: 2026-08-20\n---\n\n# ${id.toUpperCase()}\n\n${body}\n`,
    "utf8",
  );
}

describe("starting and stopping a preview", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "aibuildos-previews-"));
  });

  afterEach(async () => {
    killPreviews(); // safety net — a failed assertion must not leave a server running
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports no way to run when the project has no playbook, and when one has no run fence", async () => {
    const noPlaybook = await startPreview(dir);
    expect(noPlaybook).toEqual({
      ok: false,
      message: "This project declares no way to run — no active playbook carries a `run` fence.",
    });

    writePlaybook(dir, "pb-0001", "active", "Nothing declared here.");
    const noFence = await startPreview(dir);
    expect(noFence.ok).toBe(false);
  });

  it("ignores a retired playbook's run fence", async () => {
    const port = await freePort();
    writePlaybook(
      dir,
      "pb-0001",
      "retired",
      [
        "```run",
        `"${process.execPath}" -e "process.exit(0)"`,
        `http://localhost:${port}`,
        "```",
      ].join("\n"),
    );
    const result = await startPreview(dir);
    expect(result.ok).toBe(false);
  });

  it("starts the declared server, reports readiness once it answers, and stop kills it", async () => {
    const port = await freePort();
    // Writes its own pid to a file (cwd is the project dir) so the test can prove the process is
    // really gone afterwards, the same shape TC-0070 asks for.
    const command =
      `"${process.execPath}" -e "require('fs').writeFileSync('pid', String(process.pid));` +
      ` require('http').createServer((q,s)=>s.end('ok')).listen(${port})"`;
    writePlaybook(
      dir,
      "pb-0001",
      "active",
      ["```run", command, `http://localhost:${port}`, "```"].join("\n"),
    );

    const result = await startPreview(dir);
    expect(result).toEqual({ ok: true, url: `http://localhost:${port}` });

    const pid = Number(readFileSync(join(dir, "pid"), "utf8"));
    expect(isAlive(pid)).toBe(true);

    await stopPreview(dir);
    expect(await waitUntilDead(pid)).toBe(true);
  });

  it("reports a command's own words when it dies before answering", async () => {
    const command = `"${process.execPath}" -e "console.error('boom, nothing to serve'); process.exit(3)"`;
    writePlaybook(
      dir,
      "pb-0001",
      "active",
      ["```run", command, "http://localhost:1", "```"].join("\n"),
    );

    const result = await startPreview(dir);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("boom, nothing to serve");
  });

  it("killPreviews leaves nothing running", async () => {
    const port = await freePort();
    const command =
      `"${process.execPath}" -e "require('fs').writeFileSync('pid', String(process.pid));` +
      ` require('http').createServer((q,s)=>s.end('ok')).listen(${port})"`;
    writePlaybook(
      dir,
      "pb-0001",
      "active",
      ["```run", command, `http://localhost:${port}`, "```"].join("\n"),
    );

    const result = await startPreview(dir);
    expect(result.ok).toBe(true);
    const pid = Number(readFileSync(join(dir, "pid"), "utf8"));

    killPreviews();
    expect(await waitUntilDead(pid)).toBe(true);
  });
});
