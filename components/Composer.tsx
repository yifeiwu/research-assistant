"use client";

import { useEffect, useRef } from "react";
import { ArrowUp, Square } from "lucide-react";
import { EffortSelector } from "./EffortSelector";
import { ModelSelector } from "./ModelSelector";
import type { ProviderSettings } from "@/lib/provider";

/**
 * Two-row composer: the textarea sits on top, with a control bar below holding
 * the generation controls (model, effort) on the left and Send/Stop on the
 * right. Send and Stop share the same footprint so the layout doesn't shift
 * mid-stream.
 */
export function Composer({
  input,
  setInput,
  onSubmit,
  onStop,
  disabled,
  busy,
  autoFocus,
  inputRef,
  settings,
  onSettingsChange,
  onOpenSettings,
}: {
  input: string;
  setInput: (v: string) => void;
  onSubmit: () => void;
  onStop?: () => void;
  disabled?: boolean;
  busy?: boolean;
  autoFocus?: boolean;
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
  settings: ProviderSettings;
  onSettingsChange: (next: ProviderSettings) => void;
  onOpenSettings: () => void;
}) {
  const localRef = useRef<HTMLTextAreaElement>(null);
  const ref = inputRef ?? localRef;

  // Grow the textarea with its content, up to the CSS max-height.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [input, ref]);

  return (
    <div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
        className="flex flex-col gap-2 rounded-2xl border border-border bg-surface p-2 focus-within:border-accent"
      >
        <textarea
          ref={ref}
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus={autoFocus}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              onSubmit();
            }
          }}
          rows={1}
          placeholder="Ask a research question…"
          className="max-h-40 w-full resize-none overflow-y-auto bg-transparent px-2 py-1.5 text-foreground outline-none placeholder:text-muted"
        />

        <div className="flex items-center gap-2">
          <ModelSelector
            settings={settings}
            onChange={onSettingsChange}
            onOpenSettings={onOpenSettings}
          />
          <EffortSelector
            effort={settings.effort}
            onChange={(effort) => onSettingsChange({ ...settings, effort })}
          />

          <div className="ml-auto">
            {busy && onStop ? (
              <button
                type="button"
                onClick={onStop}
                aria-label="Stop generating"
                className="flex h-9 w-9 items-center justify-center rounded-xl bg-surface-2 text-foreground transition hover:bg-border"
              >
                <Square className="h-4 w-4 fill-current" aria-hidden />
              </button>
            ) : (
              <button
                type="submit"
                disabled={disabled || !input.trim()}
                aria-label="Send message"
                className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <ArrowUp className="h-4 w-4" aria-hidden />
              </button>
            )}
          </div>
        </div>
      </form>

      <p className="mt-1.5 px-1 text-center text-[11px] text-muted/70">
        Enter to send · Shift+Enter for newline
      </p>
    </div>
  );
}
