import { describe, expect, it } from "vitest";
import { describeAgent, TIER_1_AGENTS } from "./index.js";

describe("agent descriptors", () => {
  it("exposes the three Tier-1 agents", () => {
    expect(TIER_1_AGENTS.map((a) => a.id)).toEqual(["claude-code", "codex-cli", "pi"]);
  });

  it("looks an agent up by id", () => {
    expect(describeAgent("pi")?.displayName).toBe("pi");
    expect(describeAgent("nope")).toBeUndefined();
  });
});
