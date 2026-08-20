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
/** What may be *given* to a save: the defaulted fields need not be, which is what keeps an older
 * settings file — and a caller that only knows about one field — from being a parse failure. */
export type SettingsInput = Parameters<typeof SettingsSchema.parse>[0];
export type Appearance = ReturnType<typeof AppearanceSchema.parse>;

/** Following the system is what a fresh installation does, and what an unreadable file falls back to. */
export const DEFAULTS: Settings = { appearance: "system", sidebarCollapsed: false, layout: null };

/**
 * The settings as the file has them: `DEFAULTS` when there is no file, and **`null`** when there is
 * one that cannot be used.
 *
 * The two are told apart on purpose, exactly as the harness store tells them apart. A fresh install
 * and someone's stray comma both end up following the system, but only one of them is worth saying
 * anything about — and silently reverting a saved choice with nothing on screen is how a person
 * concludes the setting does not work.
 */
export function readSettings(file: string): Settings | null {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return DEFAULTS;
  }

  try {
    return SettingsSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * The settings, whatever the file says. Never throws: an application that will not start because of
 * one bad character in a file nobody remembers editing is worse than one that ignores it.
 */
export function loadSettings(file: string): Settings {
  return readSettings(file) ?? DEFAULTS;
}

export function saveSettings(file: string, settings: SettingsInput): Settings {
  const next = SettingsSchema.parse(settings);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}
