import type { ReactElement } from "react";
import { describe, expect, test, vi } from "vitest";
import type { ActivityDock } from "../dock/ActivityDock.js";
import type { ReviewTab } from "../review/ReviewTab.js";
import { Row } from "./RecordRail.js";

/**
 * TC-0105 (RQ-0041#AC-1, AC-3) — component-level, without a DOM.
 *
 * This workspace has no `jsdom`/`happy-dom` and no `@testing-library/react`, and the shared
 * `vitest.config.ts` collects only `*.test.ts` (not `.tsx`) — TC-0105's binding names a `.tsx`
 * file neither exists here. `Row` has no hooks, so it can be called directly: what it returns is
 * the same plain `React.createElement` tree a renderer would walk, just walked by hand instead.
 */
type Element_ = ReactElement<Record<string, unknown>>;

function findAll(
  node: unknown,
  matches: (testId: string) => boolean,
  out: Element_[] = [],
): Element_[] {
  if (node === null || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, matches, out);
    return out;
  }
  const element = node as Element_;
  const testId = element.props?.["data-testid"];
  if (typeof testId === "string" && matches(testId)) out.push(element);
  findAll(element.props?.children, matches, out);
  return out;
}

describe("Row's inbound edges (AC-1)", () => {
  test("render as buttons, and pressing one opens that artifact — preview, like the row's own click", () => {
    const onOpen = vi.fn();
    const tree = Row({
      artifact: {
        id: "RQ-0001",
        type: "Requirement",
        title: "The thing",
        state: "ready",
        file: "docs/requirements/rq-0001.md",
        problems: { errors: 0, warnings: 0 },
        inbound: [
          { relationship: "implements", id: "ST-0001" },
          { relationship: "verifies", id: "TC-0001" },
        ],
      },
      expanded: true,
      changed: false,
      onToggle: () => {},
      onOpen,
      onWorkOn: () => {},
    });

    const buttons = findAll(tree, (id) => id.startsWith("record-inbound-"));
    expect(buttons.map((b) => b.props["data-testid"])).toEqual([
      "record-inbound-ST-0001",
      "record-inbound-TC-0001",
    ]);
    for (const button of buttons) expect(button.type).toBe("button");

    const [first] = buttons;
    if (first === undefined) throw new Error("expected an inbound button for ST-0001");
    (first.props.onClick as () => void)();
    expect(onOpen).toHaveBeenCalledWith(
      { id: "ST-0001", kind: "artifact", title: "ST-0001" },
      { preview: true },
    );
  });

  test("a row with no inbound edges renders none", () => {
    const tree = Row({
      artifact: {
        id: "ST-0099",
        type: "Story",
        title: "Nothing points here",
        state: "draft",
        file: "docs/user-stories/st-0099.md",
        problems: { errors: 0, warnings: 0 },
        inbound: [],
      },
      expanded: true,
      changed: false,
      onToggle: () => {},
      onOpen: () => {},
      onWorkOn: () => {},
    });

    expect(findAll(tree, (id) => id.startsWith("record-inbound-"))).toHaveLength(0);
  });
});

// AC-3: the dead props are gone. Excess-property checks on a literal fail the build the moment
// either callback returns to its component's props — `bun run typecheck` is what actually proves
// this; these two assignments only exist to give it something to fail on. `NowTab` died with the
// activity dock (RQ-0044, DC-0027); `ActivityDock` inherits the same invariant.
const _noOnPrompt: Parameters<typeof ActivityDock>[0] = {
  projectId: "p",
  onOpen: () => {},
  collapsed: true,
  onToggle: () => {},
  // @ts-expect-error ActivityDock declares no `onPrompt` (RQ-0041#AC-3) — restoring it breaks this line.
  onPrompt: () => {},
};

const _noOnOpen: Parameters<typeof ReviewTab>[0] = {
  projectId: "p",
  storyId: "ST-0001",
  onPrompt: () => {},
  // @ts-expect-error ReviewTab declares no `onOpen` (RQ-0041#AC-3) — restoring it breaks this line.
  onOpen: () => {},
};

void _noOnPrompt;
void _noOnOpen;
