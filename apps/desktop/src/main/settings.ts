import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type AppearanceSchema, SettingsSchema } from "@aibuildos/ipc";

/**
 * Installation settings (ST-0019#AC-3). Plain JSON on disk, the same shape as the harness store.
 *
 * The path is a parameter rather than something this module looks up, which is what lets it be tested
 * on Node with a temp directory and what lets the end-to-end test point the app at fresh config.
 */
/**
 * Where the settings live. `userData` is passed in rather than looked up, which is what keeps this
 * module free of Electron — and the environment override is what lets the end-to-end test start from
 * a fresh installation.
 */
export function settingsFile(userData: string): string {
  return process.env.AIBUILDOS_SETTINGS_FILE ?? join(userData, "settings.json");
}

export type Settings = ReturnType<typeof SettingsSchema.parse>;
export type Appearance = ReturnType<typeof AppearanceSchema.parse>;

/** Following the system is what a fresh installation does, and what an unreadable file falls back to. */
export const DEFAULTS: Settings = { appearance: "system" };

export function loadSettings(file: string): Settings {
  try {
    return SettingsSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    // Absent is a fresh install; unreadable is someone's broken edit. Neither is worth refusing to
    // start over, and neither is worth overwriting until something is deliberately saved.
    return DEFAULTS;
  }
}

export function saveSettings(file: string, settings: Settings): Settings {
  const next = SettingsSchema.parse(settings);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}
