import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { IpcBridge } from "@aibuildos/ipc";
import { _electron as electron, expect, test } from "@playwright/test";

const appRoot = fileURLToPath(new URL("..", import.meta.url));

/**
 * TC-0023. A path from the renderer never reaches outside the project.
 *
 * The renderer is not trusted — that is why the IPC boundary exists (AR-0001) — so this drives the
 * boundary directly rather than through the interface. An arbitrary **write** behind an IPC channel
 * is what any later renderer-side flaw would escalate through.
 */
test("refuses every path that leads out of the project", async () => {
  const config = mkdtempSync(join(tmpdir(), "trav-config-"));
  const work = mkdtempSync(join(tmpdir(), "trav-work-"));
  const outside = mkdtempSync(join(tmpdir(), "trav-outside-"));
  execFileSync("git", ["-C", work, "init", "--quiet"]);
  writeFileSync(join(work, "inside.txt"), "ok\n");
  writeFileSync(join(outside, "secret.txt"), "not yours\n");
  // A perfectly ordinary relative path that points somewhere else entirely.
  symlinkSync(outside, join(work, "escape"));

  writeFileSync(join(config, "harnesses.json"), "[]");
  writeFileSync(
    join(config, "projects.json"),
    JSON.stringify([{ id: "p1", name: "demo", path: work, lastOpened: null }]),
  );

  const app = await electron.launch({
    args: ["."],
    cwd: appRoot,
    env: {
      ...process.env,
      AIBUILDOS_PROJECTS_FILE: join(config, "projects.json"),
      AIBUILDOS_HARNESSES_FILE: join(config, "harnesses.json"),
    },
  });
  const w = await app.firstWindow();

  const escaped = join(outside, "written-by-traversal.txt");
  const result = await w.evaluate(
    async ([escapedPath, secretPath]) => {
      const api = (globalThis as unknown as { aibuildos: IpcBridge }).aibuildos;
      const attempt = async (run: () => Promise<unknown>): Promise<string> => {
        try {
          const value = (await run()) as { problem?: string | null; text?: string | null };
          if (value?.problem) return "refused";
          return value?.text === undefined ? "ALLOWED" : "ALLOWED";
        } catch {
          // Rejected by the contract before any handler ran.
          return "refused";
        }
      };

      return {
        readUp: await attempt(() =>
          api.invoke("project:file", { id: "p1", path: "../../../../../../etc/hosts" }),
        ),
        readAbsolute: await attempt(() =>
          api.invoke("project:file", { id: "p1", path: secretPath }),
        ),
        writeUp: await attempt(() =>
          api.invoke("project:save", {
            id: "p1",
            path: `../${"written-by-traversal.txt"}`,
            text: "x",
          }),
        ),
        // The one a string check cannot catch.
        writeThroughSymlink: await attempt(() =>
          api.invoke("project:save", {
            id: "p1",
            path: "escape/written-by-traversal.txt",
            text: "x",
          }),
        ),
        listThroughSymlink: await attempt(() =>
          api.invoke("project:tree", { id: "p1", path: "escape" }),
        ),
        // And the ordinary case still works.
        readInside: await attempt(() =>
          api.invoke("project:file", { id: "p1", path: "inside.txt" }),
        ),
        escapedPath,
      };
    },
    [escaped, join(outside, "secret.txt")] as const,
  );

  expect(result.readUp).toBe("refused");
  expect(result.readAbsolute).toBe("refused");
  expect(result.writeUp).toBe("refused");
  expect(result.writeThroughSymlink).toBe("refused");
  expect(result.listThroughSymlink).toBe("refused");
  expect(result.readInside).toBe("ALLOWED");

  // Nothing was written anywhere outside the project.
  expect(existsSync(escaped)).toBe(false);
  expect(existsSync(join(outside, "written-by-traversal.txt"))).toBe(false);

  await app.close();
});
