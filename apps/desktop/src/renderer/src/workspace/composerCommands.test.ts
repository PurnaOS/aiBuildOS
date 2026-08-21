import { describe, expect, it } from "vitest";
import { commandLine, composerMenu } from "./composerCommands.js";

/**
 * RQ-0051#AC-1 and AC-2, as functions: the composer's menu groups by origin, keeps the harness's own
 * words, and offers no empty chrome. TC-0123 and TC-0124 prove the same rules through the running
 * application; this proves them where a fixture can drive every edge directly (AR-0002).
 */
describe("the composer menu, grouped by origin", () => {
  /** What `Composer.tsx` actually loads — a `PlaybookButton` plus its body and harness — so the
   * pass-through is proved on the real shape, not on a narrowed copy of it. */
  const PLAYBOOK = {
    id: "PB-0001",
    title: "Draft requirements from an idea",
    file: "docs/playbooks/pb-0001.md",
    body: "# Draft requirements",
    harness: "Stub",
  };
  const COMMANDS = [
    { name: "review", description: "Review the working tree" },
    { name: "compact" },
  ];

  it("puts playbooks first and the harness's commands under a heading naming it", () => {
    const sections = composerMenu([PLAYBOOK], COMMANDS, "Stub");

    expect(sections.map((section) => section.kind)).toEqual(["playbooks", "commands"]);
    expect(sections[0]).toEqual({
      kind: "playbooks",
      heading: "Playbooks",
      // Verbatim, body and harness included — nothing here narrows what the caller loaded.
      playbooks: [PLAYBOOK],
    });
    expect(sections[1]).toEqual({
      kind: "commands",
      heading: "Commands — Stub",
      commands: [
        {
          key: "command:review",
          name: "review",
          description: "Review the working tree",
          prompt: "/review",
        },
        // A command the harness described with nothing keeps that silence rather than inventing text.
        { key: "command:compact", name: "compact", description: undefined, prompt: "/compact" },
      ],
    });
  });

  it("leaves no empty group behind when the session advertises nothing (TC-0123)", () => {
    const sections = composerMenu([PLAYBOOK], [], "Stub");

    expect(sections).toHaveLength(1);
    expect(sections[0]?.kind).toBe("playbooks");
  });

  it("keeps the Playbooks section even with nothing in it — that heading is where seeding lives", () => {
    const sections = composerMenu([], [], "Stub");

    expect(sections).toEqual([{ kind: "playbooks", heading: "Playbooks", playbooks: [] }]);
  });

  it("shows exactly the list it was handed — a withdrawn command has no way to survive (AC-3)", () => {
    const before = composerMenu([], COMMANDS, "Stub")[1];
    const after = composerMenu([], [{ name: "compact" }], "Stub")[1];

    expect(before?.kind === "commands" && before.commands.map((entry) => entry.name)).toEqual([
      "review",
      "compact",
    ]);
    // Nothing merged, nothing remembered: only what the harness last named.
    expect(after?.kind === "commands" && after.commands.map((entry) => entry.name)).toEqual([
      "compact",
    ]);
  });

  it("keeps a name shared across origins whole — neither renamed, merged, nor dropped", () => {
    const collidingPlaybook = { ...PLAYBOOK, id: "PB-0009", title: "review" };

    const sections = composerMenu([collidingPlaybook], [{ name: "review" }], "Stub");

    expect(sections).toHaveLength(2);
    expect(sections[0]?.kind === "playbooks" && sections[0].playbooks).toEqual([collidingPlaybook]);
    expect(sections[1]?.kind === "commands" && sections[1].commands).toEqual([
      { key: "command:review", name: "review", description: undefined, prompt: "/review" },
    ]);
  });

  it("sends the harness's own text and nothing else (AC-2)", () => {
    const section = composerMenu([], [{ name: "run-tests", description: "Run them" }], "Stub")[1];

    // Exactly `/name` — no trailing space, no arguments appended: the echo stub compares this
    // string byte for byte (TC-0124).
    expect(section?.kind === "commands" && section.commands[0]?.prompt).toBe("/run-tests");
  });

  it("names whichever harness the session was started with", () => {
    const sections = composerMenu([], [{ name: "x" }], "the attached harness");

    expect(sections[1]?.heading).toBe("Commands — the attached harness");
  });
});

/**
 * AC-2's second half: what the transcript draws as a command card. `Chat.tsx`'s `UserMessage` slot
 * is the only consumer; every edge that decides card-or-prose is decided here, where no renderer is
 * needed to ask (AR-0002).
 */
describe("recognising a command in the transcript", () => {
  it("reads what the menu sends as the command it is", () => {
    // The exact string `composerMenu` produced, round-tripped: the two halves of AC-2 agree.
    expect(commandLine("/run-tests")).toBe("/run-tests");
    expect(commandLine("/plugin:skill")).toBe("/plugin:skill");
  });

  it("keeps the arguments a typed invocation carries", () => {
    expect(commandLine("/review the working tree")).toBe("/review the working tree");
  });

  it("reads prose as prose", () => {
    expect(commandLine("Please review the working tree")).toBeNull();
    expect(commandLine("")).toBeNull();
    expect(commandLine("   ")).toBeNull();
  });

  it("does not mistake a pasted path for a command", () => {
    expect(commandLine("/Users/srini/code/aiBuildOS")).toBeNull();
    expect(commandLine("/ ")).toBeNull();
    expect(commandLine("/2fast")).toBeNull();
  });

  it("reads anything longer than a line as the message it is", () => {
    // A playbook body starts with its own heading, not a slash — but an agent instruction pasted
    // under a command line is still a message, not a command.
    expect(commandLine("/review\nand then explain it")).toBeNull();
  });

  it("ignores the whitespace a composer leaves behind", () => {
    expect(commandLine("  /review  ")).toBe("/review");
    expect(commandLine("/review\n")).toBe("/review");
  });
});
