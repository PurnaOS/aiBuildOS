import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChannelResponse, IpcMainLike, IpcRendererLike } from "@aibuildos/ipc";
import { createClient } from "@aibuildos/ipc";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerIpc } from "./ipc.js";
import { seedBundle } from "./scaffold.js";

/**
 * TC-0042. `createHandlers` is not exported — `registerIpc` is, and the router it builds is already
 * proven testable without Electron by `packages/ipc/src/router.test.ts` (DC-0006). Same fake here:
 * an in-memory `IpcMainLike`/`IpcRendererLike` pair, driven through the typed client so a request that
 * violated its own contract would fail the test rather than reach the handler at all.
 *
 * The registry never touches `app.getPath` for these channels because `AIBUILDOS_PROJECTS_FILE` is
 * set for every test — the same override the e2e specs use to avoid a real Electron `userData` dir.
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

const RQ_OK = `---
type: Requirement
id: RQ-0001
title: "The clean one"
state: draft
owner: srini
provenance: human
created: 2026-08-20
kind: functional
---

# RQ-0001 — The clean one

## Acceptance criteria

- [AC-1] Nothing wrong with it.
`;

/** Invalid on purpose: the profile requires `kind` on a Requirement. */
const RQ_MISSING_KIND = `---
type: Requirement
id: RQ-0002
title: "The erroneous one"
state: draft
owner: srini
provenance: human
created: 2026-08-20
---

# RQ-0002 — The erroneous one

## Acceptance criteria

- [AC-1] Missing its \`kind\`.
`;

/** Fixed version of RQ-0002, for the "the mark follows the file" half of TC-0042. */
const RQ_FIXED = RQ_MISSING_KIND.replace(
  "provenance: human\ncreated: 2026-08-20\n",
  "provenance: human\ncreated: 2026-08-20\nkind: functional\n",
);

/** Invalid on purpose: `fixed_by` is not a relationship Requirement declares — a warning, not an error. */
const RQ_UNDECLARED_LINK = `---
type: Requirement
id: RQ-0003
title: "The warned one"
state: draft
owner: srini
provenance: human
created: 2026-08-20
kind: functional
links:
  fixed_by: [RQ-0001]
---

# RQ-0003 — The warned one

## Acceptance criteria

- [AC-1] Points at a real artifact, wrongly.
`;

describe("project:record carries findings per artifact (ST-0025)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "aibuildos-ipc-record-"));
    // `{{OWNER}}` filled in, the same as any project the scaffold actually created — a fixture that
    // starts dirty (an unresolved placeholder is itself a `doc/field-required` finding, on every
    // seeded playbook) would make "none on the clean one" untestable.
    seedBundle(dir, "srini");
    writeFileSync(join(dir, "docs/requirements/rq-0001.md"), RQ_OK);
    writeFileSync(join(dir, "docs/requirements/rq-0002.md"), RQ_MISSING_KIND);
    writeFileSync(join(dir, "docs/requirements/rq-0003.md"), RQ_UNDECLARED_LINK);
    const index = join(dir, "docs/requirements/README.md");
    writeFileSync(
      index,
      `${readFileSync(index, "utf8")}` +
        "| [RQ-0001](rq-0001.md) | The clean one | draft | — |\n" +
        "| [RQ-0002](rq-0002.md) | The erroneous one | draft | — |\n" +
        "| [RQ-0003](rq-0003.md) | The warned one | draft | — |\n",
    );

    process.env.AIBUILDOS_PROJECTS_FILE = join(dir, "projects.json");
    writeFileSync(
      process.env.AIBUILDOS_PROJECTS_FILE,
      JSON.stringify([{ id: "p1", name: "fixture", path: dir, lastOpened: null }]),
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.AIBUILDOS_PROJECTS_FILE;
  });

  function readRecord(): Promise<ChannelResponse<"project:record">> {
    const ipc = createFakeIpc();
    registerIpc(ipc, () => null);
    return createClient(ipc).invoke("project:record", { id: "p1" });
  }

  function problemsOf(record: ChannelResponse<"project:record">, id: string) {
    return record.artifacts?.find((artifact) => artifact.id === id)?.problems;
  }

  it("attaches counts to the right artifact, distinguishing severity, and none on the clean one", async () => {
    const record = await readRecord();

    expect(problemsOf(record, "RQ-0001")).toEqual({ errors: 0, warnings: 0 });
    expect(problemsOf(record, "RQ-0002")).toEqual({ errors: 1, warnings: 0 });
    expect(problemsOf(record, "RQ-0003")).toEqual({ errors: 0, warnings: 1 });
  });

  it("clears the count once the file on disk is fixed", async () => {
    writeFileSync(join(dir, "docs/requirements/rq-0002.md"), RQ_FIXED);

    const record = await readRecord();

    expect(problemsOf(record, "RQ-0002")).toEqual({ errors: 0, warnings: 0 });
  });
});
