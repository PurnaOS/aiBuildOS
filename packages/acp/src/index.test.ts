import { describe, expect, it } from "vitest";
import { HARNESS_PRESETS } from "./index.js";

describe("harness presets", () => {
  it("gives every preset a unique id and a command to run", () => {
    expect(new Set(HARNESS_PRESETS.map((p) => p.id)).size).toBe(HARNESS_PRESETS.length);
    for (const preset of HARNESS_PRESETS) {
      expect(preset.command).not.toBe("");
      expect(preset.args.length).toBeGreaterThan(0);
    }
  });
});
