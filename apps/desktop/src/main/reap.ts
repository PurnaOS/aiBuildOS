import { type ChildProcess, execFileSync } from "node:child_process";

/**
 * Killing a `spawn(command, { shell: true })` child must reach the whole tree, not just the shell.
 *
 * The first CI run on Linux proved the ceiling `killChecks`/`stopPreview` had marked: macOS's
 * `/bin/sh` (bash) execs into a single simple command, so killing the child kills the work — but
 * Debian's `/bin/sh` (dash) stays resident as a wrapper, and `child.kill()` orphans the real
 * process, which keeps the stdio pipes open and the app waiting. Windows has the same shape via
 * `cmd.exe /c`.
 *
 * So: spawn with `detached` on POSIX (the child leads its own process group) and reap the group;
 * on Windows, `taskkill /T` walks the tree instead.
 */
export const spawnDetached = process.platform !== "win32";

/** Kill a shell-spawned child and everything it spawned. Safe to call on an already-dead child. */
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
