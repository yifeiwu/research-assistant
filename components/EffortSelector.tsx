"use client";

import { useCallback, useRef, useState } from "react";
import { Check, ChevronDown, Zap } from "lucide-react";
import { EFFORT_OPTIONS, type EffortLevel } from "@/lib/effort";
import { useMenuDismiss } from "@/lib/hooks/useMenuDismiss";

/**
 * Compact control next to the Send button that lets the user pick the research
 * effort (low / medium / high).
 */
export function EffortSelector({
  effort,
  onChange,
}: {
  effort: EffortLevel;
  onChange: (effort: EffortLevel) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useMenuDismiss(open, wrapRef, close);

  const current = EFFORT_OPTIONS.find((o) => o.id === effort);

  return (
    <div className="relative" ref={wrapRef}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Research effort"
        className="flex items-center gap-1.5 rounded-lg border border-border bg-surface-2 px-2.5 py-1.5 text-xs font-medium text-muted transition hover:border-accent hover:text-foreground"
      >
        <Zap className="h-3.5 w-3.5" aria-hidden />
        <span className="hidden sm:inline">Effort:</span>
        <span className="text-foreground">{current?.label ?? "Medium"}</span>
        <ChevronDown className="h-3.5 w-3.5" aria-hidden />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute bottom-full left-0 z-30 mb-2 w-60 overflow-hidden rounded-xl border border-border bg-surface p-1 shadow-2xl"
        >
          {EFFORT_OPTIONS.map((option) => {
            const active = option.id === effort;
            return (
              <button
                key={option.id}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                onClick={() => {
                  onChange(option.id);
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
                  {active && <Check className="h-3.5 w-3.5 text-accent" aria-hidden />}
                  {option.label}
                </span>
                <span className="text-xs text-muted">{option.hint}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
