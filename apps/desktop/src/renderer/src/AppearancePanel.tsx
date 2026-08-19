import { useEffect, useState } from "react";
import { eyebrow, focusRing } from "./ui.js";

/**
 * Choosing the appearance (ST-0019).
 *
 * Three choices and no preview swatch: the window itself is the preview, because the change is made
 * at the platform level and takes effect everywhere at once.
 *
 * Nothing here records which appearance is *in force* — that is what the media query is for, and this
 * would be a second answer to it. What is stored is the user's instruction, which is a different
 * thing: `system` is an instruction to keep following, not a colour.
 */
type Appearance = "system" | "light" | "dark";

const CHOICES: { value: Appearance; label: string; hint: string }[] = [
  { value: "system", label: "System", hint: "Follow the desktop" },
  { value: "light", label: "Light", hint: "Always light" },
  { value: "dark", label: "Dark", hint: "Always dark" },
];

export function AppearancePanel(): React.JSX.Element {
  const [appearance, setAppearance] = useState<Appearance | null>(null);

  useEffect(() => {
    let live = true;
    void window.aibuildos.invoke("settings:get", {}).then((settings) => {
      if (live) setAppearance(settings.appearance);
    });
    return () => {
      live = false;
    };
  }, []);

  const choose = async (next: Appearance): Promise<void> => {
    // Shown from what was saved, not from what was clicked: the setting in force is the one on disk.
    const settings = await window.aibuildos.invoke("settings:set-appearance", { appearance: next });
    setAppearance(settings.appearance);
  };

  return (
    <section data-testid="appearance-panel" className="w-full max-w-2xl">
      <h2 className={`mb-2 ${eyebrow}`}>Appearance</h2>

      <div className="flex gap-2">
        {CHOICES.map((choice) => (
          <button
            key={choice.value}
            type="button"
            data-testid={`appearance-${choice.value}`}
            data-active={appearance === choice.value}
            disabled={appearance === null}
            onClick={() => void choose(choice.value)}
            className={`flex-1 rounded border px-3 py-2 text-left text-sm ${focusRing} ${
              appearance === choice.value
                ? "border-neutral-900 dark:border-neutral-100"
                : "border-neutral-300 hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
            }`}
          >
            <span className="block font-medium">{choice.label}</span>
            <span className="block text-xs text-neutral-500">{choice.hint}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
