import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

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
export interface Harness {
  readonly id: string;
  readonly displayName: string;
  readonly command: string;
  readonly args: string[];
  readonly cwd?: string | undefined;
}

/**
 * A missing, unreadable or malformed file is an empty list, never a throw. The alternative is an app
 * that cannot start because of one bad character in a config file nobody remembers editing.
 */
export function loadHarnesses(file: string): Harness[] {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return [];
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isHarness) : [];
  } catch {
    return [];
  }
}

/** Upsert: no `id` creates, an existing `id` replaces in place. */
export function saveHarness(
  file: string,
  harness: Omit<Harness, "id"> & { id?: string | undefined },
): Harness {
  const harnesses = loadHarnesses(file);
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
    loadHarnesses(file).filter((harness) => harness.id !== id),
  );
}

function write(file: string, harnesses: Harness[]): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(harnesses, null, 2)}\n`, "utf8");
}

function isHarness(value: unknown): value is Harness {
  const candidate = value as Partial<Harness> | null;
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    typeof candidate.id === "string" &&
    typeof candidate.displayName === "string" &&
    typeof candidate.command === "string" &&
    Array.isArray(candidate.args)
  );
}
