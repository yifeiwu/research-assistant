"use client";

import { useState } from "react";
import { Brain, ChevronDown } from "lucide-react";

export function Reasoning({
  text,
  streaming,
}: {
  text: string;
  streaming: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="my-2 rounded-xl border border-border bg-surface-2/40 text-sm">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-muted"
        aria-expanded={open}
      >
        <Brain className="h-4 w-4" aria-hidden />
        <span className="font-medium">
          {streaming ? "Thinking…" : "Reasoning"}
        </span>
        {streaming && <span className="loading-dot text-accent">●</span>}
        <ChevronDown
          className={
            "ml-auto h-4 w-4 transition-transform " + (open ? "rotate-180" : "")
          }
          aria-hidden
        />
      </button>
      {open && (
        <div className="max-h-72 overflow-auto border-t border-border px-3 py-2 text-xs whitespace-pre-wrap text-muted">
          {text}
        </div>
      )}
    </div>
  );
}
