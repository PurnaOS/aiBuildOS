import { useCopilotChatInternal } from "@copilotkit/react-core";
import {
  type AssistantMessageProps,
  AssistantMessage as DefaultAssistantMessage,
  Markdown,
} from "@copilotkit/react-ui";
import { useState } from "react";
import { button, focusRing } from "../ui.js";
import { type QuestionSegment, splitAsks } from "./asks.js";

/**
 * `CopilotChat`'s `AssistantMessage` seam (ST-0030, DC-0020): a completed message carrying a
 * question fence gets a card where the fence was. Streaming, a fence-free message, and a fence that
 * does not parse all fall straight through to the default component, untouched (RQ-0016#AC-4, AC-5).
 *
 * `Markdown` is the same renderer the default component reaches for — imported, not reimplemented —
 * so the only new work here is choosing which of two renderers a segment gets.
 */
export function AsksAssistantMessage(props: AssistantMessageProps): React.JSX.Element {
  const content = props.message?.content ?? "";
  const streaming = props.isLoading || props.isGenerating;
  const segments = streaming || content === "" ? null : splitAsks(content);
  const hasQuestion = segments?.some((segment) => segment.kind === "question") ?? false;

  if (segments === null || !hasQuestion) return <DefaultAssistantMessage {...props} />;

  return (
    <div className="copilotKitMessage copilotKitAssistantMessage">
      {segments.map((segment, index) =>
        segment.kind === "prose" ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed split of one already-complete message
          <Markdown key={index} content={segment.text} components={props.markdownTagRenderers} />
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed split of one already-complete message
          <QuestionCard key={index} question={segment} />
        ),
      )}
    </div>
  );
}

/**
 * The card DC-0020 describes: the agent's own wording, its own options, a tap sending the option's
 * label back through the ordinary prompt path (RQ-0016#AC-2) — the same `sendMessage` the composer
 * and the playbook strip use, so a tap is indistinguishable from something the person typed.
 *
 * Never blocks (RQ-0016#AC-4): the composer beside it keeps working, and this stays tappable for as
 * long as it stays on screen.
 */
function QuestionCard({ question }: { question: QuestionSegment }): React.JSX.Element {
  const { sendMessage } = useCopilotChatInternal();
  const [chosen, setChosen] = useState<string | null>(null);

  const pick = (option: QuestionSegment["options"][number]): void => {
    setChosen(option.label);
    void sendMessage({ id: crypto.randomUUID(), role: "user", content: option.label });
  };

  return (
    <div
      data-testid="question-card"
      className="my-2 rounded border border-neutral-300 p-3 dark:border-neutral-700"
    >
      <p className="text-sm">{question.question}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {question.options.map((option) => (
          <button
            key={option.id}
            type="button"
            data-testid={`question-option-${option.id}`}
            className={`${button} ${focusRing}`}
            onClick={() => pick(option)}
          >
            {option.label}
          </button>
        ))}
      </div>
      {/* What was chosen is a word, not a colour on the button that picked it (RQ-0016#AC-2). */}
      {chosen !== null && (
        <p data-testid="question-chosen" className="mt-2 text-xs text-neutral-500">
          You chose: {chosen}
        </p>
      )}
      <p className="mt-2 text-xs text-neutral-500">…or type your own answer below</p>
    </div>
  );
}
