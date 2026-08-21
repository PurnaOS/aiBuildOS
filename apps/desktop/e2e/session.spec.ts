import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { IpcBridge } from "@aibuildos/ipc";
import { _electron as electron, expect, test } from "@playwright/test";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const stub = fileURLToPath(new URL("../../../tools/stub-acp-agent/src/agent.ts", import.meta.url));

/**
 * TC-0020. A live session's narration crosses the real boundary into a real renderer.
 *
 * The unit tests prove the session, the bridge and the event channel each work. This proves they are
 * actually wired to one another through Electron — the part no in-memory fake can tell us.
 */
test("streams a turn from the agent into the renderer, and cancels one", async () => {
  const config = mkdtempSync(join(tmpdir(), "aibuildos-session-e2e-"));
  const work = mkdtempSync(join(tmpdir(), "aibuildos-session-work-"));
  execFileSync("git", ["-C", work, "init", "--quiet"]);

  const harness = (id: string, mode: string) => ({
    id,
    displayName: `Stub ${mode}`,
    command: process.execPath,
    args: ["--experimental-strip-types", stub, `--mode=${mode}`],
  });

  writeFileSync(
    join(config, "harnesses.json"),
    JSON.stringify([harness("rich", "rich"), harness("slow", "slow")]),
  );
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
      AIBUILDOS_SETTINGS_FILE: join(config, "settings.json"),
    },
  });
  const w = await app.firstWindow();
  await expect(w.getByTestId("title")).toBeVisible();

  // Drive the boundary directly: the three-pane workspace that will do this from a composer is
  // ST-0011, and this case is about the wiring underneath it.
  const streamed = await w.evaluate(async () => {
    const api = (globalThis as unknown as { aibuildos: IpcBridge }).aibuildos;
    const seen: { type: string; name?: string }[] = [];
    const stop = api.subscribe("session:event", (payload) => {
      seen.push(payload.event as { type: string; name?: string });
    });

    const started = await api.invoke("session:start", { projectId: "p1", harnessId: "rich" });
    if (!started.ok) return { error: `${started.code}: ${started.message}` };

    const { stopReason } = await api.invoke("session:prompt", {
      sessionId: started.sessionId,
      text: "do the thing",
    });
    // The prompt's reply and the RUN_FINISHED event race across the boundary; wait for the event
    // rather than asserting on whichever happened to arrive first.
    for (let i = 0; i < 50 && !seen.some((e) => e.type === "RUN_FINISHED"); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    stop();
    await api.invoke("session:close", { sessionId: started.sessionId });

    return {
      stopReason,
      types: seen.map((e) => e.type),
      names: seen.map((e) => e.name).filter(Boolean),
    };
  });

  expect(streamed.error).toBeUndefined();
  const types = streamed.types ?? [];
  const names = streamed.names ?? [];
  expect(streamed.stopReason).toBe("end_turn");
  // The agent's own narration, bridged, arriving in the renderer as AG-UI.
  expect(types).toContain("RUN_STARTED");
  expect(types).toContain("TEXT_MESSAGE_CONTENT");
  expect(types).toContain("REASONING_MESSAGE_CONTENT");
  expect(types).toContain("RUN_FINISHED");
  expect(types).toContain("TOOL_CALL_START");
  expect(names).toContain("acp.plan");
  // Nothing here is ACP's vocabulary; the renderer never sees a `sessionUpdate`.
  expect(types.every((t) => t === t.toUpperCase())).toBe(true);

  const cancelled = await w.evaluate(async () => {
    const api = (globalThis as unknown as { aibuildos: IpcBridge }).aibuildos;
    const started = await api.invoke("session:start", { projectId: "p1", harnessId: "slow" });
    if (!started.ok) return { error: `${started.code}: ${started.message}` };

    const turn = api.invoke("session:prompt", { sessionId: started.sessionId, text: "count" });
    await new Promise((resolve) => setTimeout(resolve, 150));
    await api.invoke("session:cancel", { sessionId: started.sessionId });

    const { stopReason } = await turn;
    await api.invoke("session:close", { sessionId: started.sessionId });
    return { stopReason };
  });

  expect(cancelled.error).toBeUndefined();
  expect(cancelled.stopReason).toBe("cancelled");

  await app.close();
});
