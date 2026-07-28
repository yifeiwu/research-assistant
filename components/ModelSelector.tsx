"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Cpu, SlidersHorizontal } from "lucide-react";
import { GROQ_MODELS } from "@/lib/models";
import { currentModelLabel, type ProviderSettings } from "@/lib/provider";

/**
 * Compact model picker for the composer control bar. Offers a quick switch
 * between Groq models, and a link into the full provider settings modal for
 * custom endpoints.
 */
export function ModelSelector({
  settings,
  onChange,
  onOpenSettings,
}: {
  settings: ProviderSettings;
  onChange: (next: ProviderSettings) => void;
  onOpenSettings: () => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocMouseDown(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="relative" ref={wrapRef}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Model"
        className="flex items-center gap-1.5 rounded-lg border border-border bg-surface-2 px-2.5 py-1.5 text-xs font-medium text-muted transition hover:border-accent hover:text-foreground"
      >
        <Cpu className="h-3.5 w-3.5" aria-hidden />
        <span className="max-w-[8rem] truncate text-foreground sm:max-w-[12rem]">
          {currentModelLabel(settings)}
        </span>
        <ChevronDown className="h-3.5 w-3.5" aria-hidden />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute bottom-full left-0 z-30 mb-2 w-72 overflow-hidden rounded-xl border border-border bg-surface p-1 shadow-2xl"
        >
          <div className="px-2 py-1.5 text-[11px] font-medium tracking-wide text-muted uppercase">
            Groq models
          </div>
          {GROQ_MODELS.map((model) => {
            const active =
              settings.provider === "groq" && settings.groqModel === model.id;
            return (
              <button
                key={model.id}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                onClick={() => {
                  onChange({ ...settings, provider: "groq", groqModel: model.id });
                  setOpen(false);
                }}
                className={
                  "flex w-full flex-col rounded-lg px-3 py-2 text-left transition " +
                  (active
                    ? "bg-accent/10 text-foreground"
                    : "text-muted hover:bg-surface-2 hover:text-foreground")
                }
              >
                <span className="flex items-center gap-1.5 text-sm font-medium">
                  {active && (
                    <Check className="h-3.5 w-3.5 text-accent" aria-hidden />
                  )}
                  {model.label}
                </span>
                {model.hint && (
                  <span className="text-xs text-muted">{model.hint}</span>
                )}
              </button>
            );
          })}

          <div className="my-1 border-t border-border" />
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onOpenSettings();
            }}
            className={
              "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition hover:bg-surface-2 " +
              (settings.provider === "custom"
                ? "text-foreground"
                : "text-muted hover:text-foreground")
            }
          >
            <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden />
            {settings.provider === "custom"
              ? "Custom endpoint & settings…"
              : "Custom provider & settings…"}
          </button>
        </div>
      )}
    </div>
  );
}
