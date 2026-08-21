import { describe, expect, it } from "vitest";
import { groupAgentSettings, supervisionReach, valueName } from "./agentControls.js";

/**
 * TC-0107. The popover groups by origin and never dedupes — as functions, since there is no
 * component-rendering harness in this codebase (AR-0002: pure modules are what a test can call
 * directly).
 */
describe("grouping agent settings by origin", () => {
  const MODES = [
    { id: "plan", name: "Plan" },
    { id: "code", name: "Code" },
  ];
  const MODEL = {
    id: "model",
    name: "Model",
    currentValue: "sonnet",
    options: [
      { value: "sonnet", name: "Sonnet" },
      { value: "opus", name: "Opus" },
    ],
  };

  it("puts the session mode under Session and the harness's own options under its displayName", () => {
    expect(groupAgentSettings(MODES, "plan", [MODEL], "Stub")).toEqual([
      {
        heading: "Session",
        options: [
          {
            id: "mode",
            name: "Mode",
            currentValue: "plan",
            options: [
              { value: "plan", name: "Plan" },
              { value: "code", name: "Code" },
            ],
          },
        ],
      },
      { heading: "Agent options — Stub", options: [MODEL] },
    ]);
  });

  it("keeps a name collision between origins whole — neither renamed, merged, nor dropped", () => {
    const collidingOption = { id: "style", name: "Mode", currentValue: "auto", options: [] };

    const groups = groupAgentSettings(MODES, "plan", [collidingOption], "Stub");

    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ heading: "Session", options: [{ name: "Mode" }] });
    expect(groups[1]).toEqual({ heading: "Agent options — Stub", options: [collidingOption] });
  });

  it("omits a group with nothing to show, and returns nothing when the agent offers nothing", () => {
    expect(groupAgentSettings([], "plan", [MODEL], "Stub")).toEqual([
      { heading: "Agent options — Stub", options: [MODEL] },
    ]);
    expect(groupAgentSettings(MODES, "plan", [], "Stub")).toEqual([
      {
        heading: "Session",
        options: [
          {
            id: "mode",
            name: "Mode",
            currentValue: "plan",
            options: [
              { value: "plan", name: "Plan" },
              { value: "code", name: "Code" },
            ],
          },
        ],
      },
    ]);
    expect(groupAgentSettings([], null, [], "Stub")).toEqual([]);
  });
});

/**
 * TC-0120's pure half (RQ-0050#AC-3, AC-4). What the Supervision section is allowed to claim: only
 * that the level reached the agent when it demonstrably did, and never silence when it no longer has.
 */
describe("what the supervision section says about its reach", () => {
  const PERMISSION = {
    id: "permission_mode",
    name: "Permission mode",
    currentValue: "ask",
    options: [
      { value: "ask", name: "Ask" },
      { value: "auto", name: "Auto" },
    ],
  };
  const MAPPING = { configId: "permission_mode", value: "ask" };

  it("says the level is this application's alone when the harness maps nothing", () => {
    expect(supervisionReach(undefined, [PERMISSION], "Stub")).toEqual({
      note: "Applies in aiBuildOS only — Stub offers no option this level can set.",
      diverged: false,
    });
  });

  it("says the same when the record maps an option this agent never advertised", () => {
    // The record is not the authority on what the agent offers; claiming reach here would be
    // exactly the depth RQ-0050#AC-3 forbids implying.
    expect(
      supervisionReach({ configId: "nothing_like_it", value: "ask" }, [PERMISSION], "Stub"),
    ).toEqual({
      note: "Applies in aiBuildOS only — Stub offers no option this level can set.",
      diverged: false,
    });
  });

  it("names the option and its own value when the level is what the agent is set to", () => {
    expect(supervisionReach(MAPPING, [PERMISSION], "Stub")).toEqual({
      note: "Also sets Stub's Permission mode to Ask.",
      diverged: false,
    });
  });

  it("says so out loud once the agent has moved the option from its own side", () => {
    const moved = { ...PERMISSION, currentValue: "auto" };

    expect(supervisionReach(MAPPING, [moved], "Stub")).toEqual({
      note: "Stub's Permission mode is now Auto — changed on the agent's side.",
      diverged: true,
    });
  });
});

describe("reading a config option's displayed value", () => {
  it("reads a boolean as on/off", () => {
    expect(valueName({ id: "a", name: "A", currentValue: true })).toBe("on");
    expect(valueName({ id: "a", name: "A", currentValue: false })).toBe("off");
  });

  it("reads a select option by its own name, not its value", () => {
    expect(
      valueName({
        id: "model",
        name: "Model",
        currentValue: "opus",
        options: [{ value: "opus", name: "Opus" }],
      }),
    ).toBe("Opus");
  });

  it("falls back to the raw value when nothing matches, and to a dash when there is none", () => {
    expect(valueName({ id: "a", name: "A", currentValue: "unlisted" })).toBe("unlisted");
    expect(valueName({ id: "a", name: "A" })).toBe("—");
  });
});
