// Re-exported by the editor package this application already depends on, rather than pulling
// `@codemirror/view` in directly and risking a second copy of it in the bundle.
import { syntaxHighlighting } from "@codemirror/language";
import { oneDarkHighlightStyle } from "@codemirror/theme-one-dark";
import { EditorView } from "@uiw/react-codemirror";
import { useSyncExternalStore } from "react";

/**
 * Which appearance is in force (ST-0018).
 *
 * Almost everything in this application is themed in CSS and needs none of this — the media query
 * decides and nothing has to be told. CodeMirror is the exception: a theme there is a JavaScript
 * extension, so the one surface a media query cannot reach has to be handed the answer.
 *
 * Handed, not decided: this reads the same media query the stylesheets do. It is an observation of
 * the browser's answer, not a second authority on the question.
 */
const QUERY = "(prefers-color-scheme: dark)";

export function useDarkAppearance(): boolean {
  return useSyncExternalStore(subscribe, () => window.matchMedia(QUERY).matches);
}

function subscribe(notify: () => void): () => void {
  const media = window.matchMedia(QUERY);
  media.addEventListener("change", notify);
  return () => media.removeEventListener("change", notify);
}

/**
 * The editor, dark.
 *
 * One Dark's **highlight style** for the syntax — a palette built for a dark ground, rather than the
 * light default's colours asked to work on one — and this application's own neutrals for the
 * surfaces, so the editor sits in the window rather than on it.
 *
 * Its highlight style rather than the whole theme: `oneDark` also brings its own chrome, and two
 * themes fighting over the same background is settled by extension precedence, which is a worse
 * thing to depend on than simply not having the fight.
 */
export const darkEditor = [
  syntaxHighlighting(oneDarkHighlightStyle),
  EditorView.theme(
    {
      "&": { backgroundColor: "#0a0a0a", color: "#f5f5f5" },
      ".cm-gutters": { backgroundColor: "#0a0a0a", color: "#525252", border: "none" },
      ".cm-activeLine": { backgroundColor: "#171717" },
      ".cm-activeLineGutter": { backgroundColor: "#171717" },
      ".cm-content": { caretColor: "#f5f5f5" },
      "&.cm-focused .cm-cursor": { borderLeftColor: "#f5f5f5" },
      "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
        backgroundColor: "#264f78",
      },
    },
    { dark: true },
  ),
];
