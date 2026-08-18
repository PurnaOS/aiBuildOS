import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { HarnessSchema } from "@aibuildos/ipc";

/**
 * The harness store (ST-0001). Plain JSON on disk, `node:fs`, no store library.
 *
 * The file path is a **parameter**, not something this module looks up: that is what lets it be
 * tested on Node with a temp directory and no Electron runtime, and what lets the end-to-end test
 * point the app at an empty config. `ipc.ts` supplies the real path.
 *
 * No credentials live here. A harness inherits the application's environment, so an agent CLI that
 * is already logged in on the machine works unchanged; per-harness secrets belong to DC-0011 and
 * arrive with their own requirement.
 */
export type Harness = ReturnType<typeof HarnessSchema.parse>;

const HarnessesSchema = HarnessSchema.array();

/**
 * `[]` for a file that is not there — a fresh install — and `null` for one that is there but cannot
 * be read as harness configuration. Reads treat both as empty; writes must not.
 */
function read(file: string): Harness[] | null {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return [];
  }

  try {
    return HarnessesSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * A missing, unreadable or malformed file is an empty list, never a throw. The alternative is an app
 * that cannot start because of one bad character in a config file nobody remembers editing.
 */
export function loadHarnesses(file: string): Harness[] {
  return read(file) ?? [];
}

/**
 * The same read, for the paths that write back.
 *
 * Reading a corrupt file as empty and then saving over it deletes every harness in it — silently,
 * because the app looks like a fresh install right up until the write lands. Refusing keeps the file
 * exactly as it is, and the renderer shows the user why.
 */
function readForWrite(file: string): Harness[] {
  const harnesses = read(file);
  if (harnesses === null) {
    throw new Error(
      `${file} exists but is not valid harness configuration. ` +
        "Move it aside or fix it by hand — saving would overwrite it.",
    );
  }
  return harnesses;
}

/** Upsert: no `id` creates, an existing `id` replaces in place. */
export function saveHarness(
  file: string,
  harness: Omit<Harness, "id"> & { id?: string | undefined },
): Harness {
  const harnesses = readForWrite(file);
  const saved: Harness = { ...harness, id: harness.id ?? randomUUID() };

  const index = harnesses.findIndex((existing) => existing.id === saved.id);
  if (index === -1) harnesses.push(saved);
  else harnesses[index] = saved;

  write(file, harnesses);
  return saved;
}

export function removeHarness(file: string, id: string): void {
  write(
    file,
    readForWrite(file).filter((harness) => harness.id !== id),
  );
}

function write(file: string, harnesses: Harness[]): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(harnesses, null, 2)}\n`, "utf8");
}
