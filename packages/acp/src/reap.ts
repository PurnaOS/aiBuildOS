import { type ChildProcess, execFileSync } from "node:child_process";

/**
 * Killing a spawned agent or runner must reach the whole tree, not just the immediate child.
 *
 * The first 3-OS CI run proved both halves of the ceiling (BG-0009): on Linux, dash (`/bin/sh`)
 * stays resident as a wrapper for shell-spawned commands, so killing the child orphans the work;
 * on Windows, `process.kill(-pid)` **always throws** — there are no POSIX process groups — so a
 * swallowed group-kill kills nothing and the survivor keeps its cwd locked (EBUSY on cleanup).
 *
 * One reaper for every spawner: POSIX children are spawned `detached` so they lead their own
 * process group and the group is signalled; Windows walks the tree with `taskkill /T /F`.
 */
export const spawnDetached = process.platform !== "win32";

/** Kill a child and everything it spawned. Safe to call on an already-dead child. */
export function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      child.kill();
    }
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    // No group to signal (spawn raced its own death) — fall back to the direct child.
    child.kill();
  }
}
