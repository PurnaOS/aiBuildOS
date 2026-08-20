import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { IpcMainLike, IpcRendererLike } from "@aibuildos/ipc";
import { createClient } from "@aibuildos/ipc";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerIpc } from "./ipc.js";
import { seedBundle } from "./scaffold.js";
import { recordGeneration, stopAllWatching, stopWatching, watchProject } from "./watch.js";

/**
 * TC-0075. The watcher debounces, filters and caches — against real temp directories and a real
 * chokidar (DC-0022): there is no second implementation of "did the filesystem change" worth
 * writing, so nothing here is faked. Waits are generous rather than tight, because what is being
 * waited on is chokidar's own detection latency, not a budget this suite owns.
 */

const DEBOUNCE_MS = 300;
const SETTLE_MS = 150; // lets chokidar finish its initial crawl before a test starts writing
const WAIT_TIMEOUT_MS = 4000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls rather than a fixed sleep, so a slow machine gets more time and a fast one finishes sooner. */
async function waitFor(predicate: () => boolean, timeout = WAIT_TIMEOUT_MS): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for a watcher event");
    await sleep(25);
  }
}

describe("the project watcher", () => {
  const dirs: string[] = [];

  function tempProject(): string {
    const dir = mkdtempSync(join(tmpdir(), "aibuildos-watch-"));
    mkdirSync(join(dir, "docs"), { recursive: true });
    dirs.push(dir);
    return dir;
  }

  afterEach(() => {
    stopAllWatching();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("fires once for a burst of writes, not once per write", async () => {
    const dir = tempProject();
    let calls = 0;
    watchProject("burst", dir, () => {
      calls += 1;
    });
    await sleep(SETTLE_MS);

    for (let i = 0; i < 5; i += 1) writeFileSync(join(dir, `f${i}.txt`), String(i), "utf8");

    await waitFor(() => calls === 1);
    // Long enough that a second, wrongly-separate event would have shown up by now.
    await sleep(DEBOUNCE_MS + 300);
    expect(calls).toBe(1);
  });

  it("stays silent for node_modules, .git/objects and build output", async () => {
    const dir = tempProject();
    let calls = 0;
    watchProject("ignored", dir, () => {
      calls += 1;
    });
    await sleep(SETTLE_MS);

    mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "pkg", "index.js"), "", "utf8");
    mkdirSync(join(dir, ".git", "objects", "ab"), { recursive: true });
    writeFileSync(join(dir, ".git", "objects", "ab", "cdef"), "", "utf8");
    mkdirSync(join(dir, "out"), { recursive: true });
    writeFileSync(join(dir, "out", "bundle.js"), "", "utf8");
    mkdirSync(join(dir, "dist"), { recursive: true });
    writeFileSync(join(dir, "dist", "bundle.js"), "", "utf8");

    await sleep(DEBOUNCE_MS + 400);
    expect(calls).toBe(0);
  });

  it("fires for a write under .git/refs", async () => {
    const dir = tempProject();
    let calls = 0;
    watchProject("refs", dir, () => {
      calls += 1;
    });
    await sleep(SETTLE_MS);

    mkdirSync(join(dir, ".git", "refs", "heads"), { recursive: true });
    writeFileSync(join(dir, ".git", "refs", "heads", "main"), "abc123\n", "utf8");

    await waitFor(() => calls === 1);
    expect(calls).toBe(1);
  });

  it("bumps the record generation for a docs/ write, not for anything else", async () => {
    const dir = tempProject();
    watchProject("gen", dir, () => {});
    await sleep(SETTLE_MS);
    const started = recordGeneration(dir);
    expect(started).toBeGreaterThan(-1); // watching itself is a bump

    writeFileSync(join(dir, "notes.txt"), "not docs", "utf8");
    await sleep(DEBOUNCE_MS + 300);
    expect(recordGeneration(dir)).toBe(started);

    writeFileSync(join(dir, "docs", "note.md"), "docs", "utf8");
    await waitFor(() => recordGeneration(dir) > started);
    expect(recordGeneration(dir)).toBeGreaterThan(started);
  });

  it("stops emitting once stopped", async () => {
    const dir = tempProject();
    let calls = 0;
    watchProject("stop", dir, () => {
      calls += 1;
    });
    await sleep(SETTLE_MS);
    writeFileSync(join(dir, "a.txt"), "a", "utf8");
    await waitFor(() => calls === 1);

    stopWatching("stop");
    writeFileSync(join(dir, "b.txt"), "b", "utf8");
    await sleep(DEBOUNCE_MS + 400);
    expect(calls).toBe(1);
  });

  it("keeps two projects' events apart", async () => {
    const dirA = tempProject();
    const dirB = tempProject();
    let callsA = 0;
    let callsB = 0;
    watchProject("iso-a", dirA, () => {
      callsA += 1;
    });
    watchProject("iso-b", dirB, () => {
      callsB += 1;
    });
    await sleep(SETTLE_MS);

    writeFileSync(join(dirA, "a.txt"), "a", "utf8");
    await waitFor(() => callsA === 1);
    await sleep(DEBOUNCE_MS + 300);
    expect(callsA).toBe(1);
    expect(callsB).toBe(0);
  });
});

/**
 * `project:record`'s cache, driven through `registerIpc` exactly as `ipc.test.ts` drives it — a fake
 * `IpcMainLike`/`IpcRendererLike` pair, so the router's own contract checking still runs.
 */
function createFakeIpc(): IpcMainLike & IpcRendererLike {
  const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>();
  return {
    handle(channel, listener) {
      handlers.set(channel, listener);
    },
    async invoke(channel, payload) {
      const listener = handlers.get(channel);
      if (!listener) throw new Error(`no handler registered for "${channel}"`);
      return await listener({}, payload);
    },
  };
}

const RQ = `---
type: Requirement
id: RQ-0001
title: "Written after the first read"
state: draft
owner: srini
provenance: human
created: 2026-08-20
kind: functional
---

# RQ-0001 — Written after the first read

## Acceptance criteria

- [AC-1] It showed up late.
`;

describe("project:record's generation cache (RQ-0026#AC-6)", () => {
  let dir: string;
  let id: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "aibuildos-watch-cache-"));
    id = basename(dir);
    seedBundle(dir, "srini");
    process.env.AIBUILDOS_PROJECTS_FILE = join(dir, "projects.json");
    writeFileSync(
      process.env.AIBUILDOS_PROJECTS_FILE,
      JSON.stringify([{ id, name: "fixture", path: dir, lastOpened: null }]),
    );
  });

  afterEach(() => {
    stopAllWatching();
    delete process.env.AIBUILDOS_PROJECTS_FILE;
    rmSync(dir, { recursive: true, force: true });
  });

  function writeRq(): void {
    writeFileSync(join(dir, "docs/requirements/rq-0001.md"), RQ);
    const index = join(dir, "docs/requirements/README.md");
    writeFileSync(
      index,
      `${readFileSync(index, "utf8")}| [RQ-0001](rq-0001.md) | Written after the first read | draft | — |\n`,
    );
  }

  it("answers an unchanged read from cache, and re-parses once the watcher sees a docs/ change", async () => {
    watchProject(id, dir, () => {});
    await sleep(SETTLE_MS);
    const startedAt = recordGeneration(dir);

    const ipc = createFakeIpc();
    registerIpc(ipc, () => null);
    const client = createClient(ipc);

    const first = await client.invoke("project:record", { id });
    expect(first.artifacts?.some((a) => a.id === "RQ-0001")).toBe(false);

    // On disk now, but nothing between here and the next `invoke` yields to the event loop, so the
    // watcher has had no chance to notice it yet — the read below has to have come from the cache.
    writeRq();
    const second = await client.invoke("project:record", { id });
    expect(second.artifacts?.some((a) => a.id === "RQ-0001")).toBe(false);

    await waitFor(() => recordGeneration(dir) > startedAt);
    const third = await client.invoke("project:record", { id });
    expect(third.artifacts?.some((a) => a.id === "RQ-0001")).toBe(true);
  });

  it("never caches when nothing is watching — a generation of -1", async () => {
    expect(recordGeneration(dir)).toBe(-1); // this project was never opened

    const ipc = createFakeIpc();
    registerIpc(ipc, () => null);
    const client = createClient(ipc);

    const first = await client.invoke("project:record", { id });
    expect(first.artifacts?.some((a) => a.id === "RQ-0001")).toBe(false);

    writeRq();
    const second = await client.invoke("project:record", { id });
    expect(second.artifacts?.some((a) => a.id === "RQ-0001")).toBe(true);
  });
});
