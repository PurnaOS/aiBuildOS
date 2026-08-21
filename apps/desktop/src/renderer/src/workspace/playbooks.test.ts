import { describe, expect, it } from "vitest";
import { backgroundHarnessId, compose, derivePlaybooks, resolveHarness } from "./playbooks.js";

/**
 * TC-0044. Playbooks are discovered from the record and composed with their context.
 *
 * Verifies RQ-0013#AC-1, AC-2 and AC-6 as functions: from a loaded record to buttons, and from a
 * playbook plus selected artifacts to the prompt text.
 */
describe("deriving playbook buttons from the record", () => {
  it("offers one button per active playbook, and none for a retired one", () => {
    const artifacts = [
      { id: "PB-0001", type: "Playbook", title: "Draft requirements", state: "active", file: "a" },
      { id: "PB-0002", type: "Playbook", title: "Retired one", state: "retired", file: "b" },
      { id: "RQ-0013", type: "Requirement", title: "Not a playbook", state: "ready", file: "c" },
    ];

    expect(derivePlaybooks(artifacts)).toEqual([
      { id: "PB-0001", title: "Draft requirements", file: "a" },
    ]);
  });

  it("offers nothing when the record has no playbooks at all", () => {
    expect(derivePlaybooks([])).toEqual([]);
  });
});

describe("composing a playbook with its context", () => {
  const BODY = "Interview me about this idea, one question at a time.";

  it("sends the body verbatim when nothing is selected", () => {
    expect(compose(BODY, [])).toBe(BODY);
  });

  it("appends one line per selected artifact, naming its ID and title", () => {
    const composed = compose(BODY, [
      { id: "RQ-0013", title: "The standard steps are buttons the project carries" },
      { id: "ST-0026", title: "The standard steps are buttons the project carries" },
    ]);

    expect(composed).toBe(
      `${BODY}\n\n` +
        "- RQ-0013: The standard steps are buttons the project carries\n" +
        "- ST-0026: The standard steps are buttons the project carries",
    );
    // Verbatim means verbatim: the body itself is untouched by the lines appended after it.
    expect(composed.startsWith(BODY)).toBe(true);
  });
});

describe("resolving a playbook's harness", () => {
  const HARNESSES = [{ displayName: "Claude Code" }, { displayName: "Codex" }];

  it("matches a preference that is configured", () => {
    expect(resolveHarness("Codex", HARNESSES, "Attached One")).toBe("Codex");
  });

  it("falls back when the preference matches nothing configured", () => {
    expect(resolveHarness("Some Other Agent", HARNESSES, "Attached One")).toBe("Attached One");
  });

  it("falls back when the playbook names no preference at all", () => {
    expect(resolveHarness(undefined, HARNESSES, "Attached One")).toBe("Attached One");
  });
});

/** RQ-0039: a background run needs a harness id, not a display name — `session:start`'s own shape. */
describe("resolving a background run's harness id", () => {
  const CONFIGURED = [
    { id: "h1", displayName: "Claude Code" },
    { id: "h2", displayName: "Codex" },
  ];

  it("matches a preference that is configured, by id", () => {
    expect(backgroundHarnessId("Codex", CONFIGURED)).toBe("h2");
  });

  it("falls back to whatever is configured first when the preference matches nothing", () => {
    expect(backgroundHarnessId("Some Other Agent", CONFIGURED)).toBe("h1");
  });

  it("falls back to the first configured harness when the playbook names no preference", () => {
    expect(backgroundHarnessId(undefined, CONFIGURED)).toBe("h1");
  });

  it("is null when nothing is configured at all", () => {
    expect(backgroundHarnessId(undefined, [])).toBeNull();
  });
});
