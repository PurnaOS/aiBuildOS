import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULTS, loadSettings, readSettings, saveSettings, settingsFile } from "./settings.js";

/**
 * TC-0032's other half: the store itself, on Node, with no Electron.
 *
 * The branches worth pinning are the ones nobody sees until they matter — a settings file someone
 * hand-edited into nonsense must not stop the application starting, and the environment override is
 * the seam the end-to-end test depends on to begin from a fresh installation.
 */
const dir = mkdtempSync(join(tmpdir(), "settings-"));
const file = join(dir, "settings.json");

afterEach(() => {
  delete process.env.AIBUILDOS_SETTINGS_FILE;
});

describe("the settings store", () => {
  it("follows the system when there is no file at all", () => {
    expect(loadSettings(join(dir, "absent.json"))).toEqual({ appearance: "system" });
    expect(DEFAULTS).toEqual({ appearance: "system" });
  });

  it("round-trips a choice", () => {
    expect(saveSettings(file, { appearance: "dark" })).toEqual({ appearance: "dark" });
    expect(loadSettings(file)).toEqual({ appearance: "dark" });
  });

  it("falls back rather than refusing to start on a file it cannot use", () => {
    for (const contents of ['{"appearance":"blue"}', "{}", "not json at all", ""]) {
      writeFileSync(file, contents, "utf8");
      expect(loadSettings(file)).toEqual({ appearance: "system" });
    }
  });

  it("tells an absent file apart from one it cannot use", () => {
    // Both end up following the system, but only one is worth saying anything about: a stray comma
    // that silently reverts a saved choice is how someone concludes the setting does not work.
    expect(readSettings(join(dir, "absent.json"))).toEqual(DEFAULTS);

    writeFileSync(file, "not json at all", "utf8");
    expect(readSettings(file)).toBeNull();
    expect(loadSettings(file)).toEqual(DEFAULTS);
  });

  it("leaves a file it could not read exactly as it was", () => {
    // Reading is not writing. The mistake stays recoverable until something deliberately saves over
    // it — which a click in Settings is, and this does not pretend otherwise.
    writeFileSync(file, "not json at all", "utf8");
    loadSettings(file);
    readSettings(file);

    expect(readFileSync(file, "utf8")).toBe("not json at all");
  });

  it("refuses to save an appearance that is not one of the three", () => {
    expect(() =>
      saveSettings(file, { appearance: "blue" } as unknown as { appearance: "dark" }),
    ).toThrow();
  });

  it("writes beside the other configuration, and honours the override", () => {
    expect(settingsFile("/somewhere/userData")).toBe("/somewhere/userData/settings.json");

    process.env.AIBUILDOS_SETTINGS_FILE = "/elsewhere/settings.json";
    expect(settingsFile("/somewhere/userData")).toBe("/elsewhere/settings.json");
  });
});
