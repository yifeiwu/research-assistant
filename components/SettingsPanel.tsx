"use client";

import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import { GROQ_MODELS } from "@/lib/models";
import type { AppSettings } from "@/lib/settings";

export function SettingsPanel({
  settings,
  onChange,
  onClose,
}: {
  settings: AppSettings;
  onChange: (next: AppSettings) => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    dialogRef.current?.focus();
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} aria-hidden />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Model settings"
        tabIndex={-1}
        className="relative z-10 w-[22rem] max-w-[90vw] rounded-2xl border border-border bg-surface p-4 text-sm shadow-2xl outline-none"
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-semibold">Model</h2>
          <button
            type="button"
            onClick={onClose}
            className="flex h-9 w-9 items-center justify-center rounded-md text-muted hover:text-foreground md:h-6 md:w-6"
            aria-label="Close settings"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
        <label className="block">
          <span className="mb-1 block text-xs text-muted">Groq model</span>
          <select
            value={settings.model}
            onChange={(e) => onChange({ ...settings, model: e.target.value })}
            className="w-full cursor-pointer rounded-lg border border-border bg-surface-2 px-2.5 py-2 text-foreground outline-none focus:border-accent"
          >
            {GROQ_MODELS.map((m) => (
              <option key={m.id} value={m.id} className="bg-surface">
                {m.label}
                {m.hint ? ` — ${m.hint}` : ""}
              </option>
            ))}
          </select>
        </label>
        <p className="mt-3 text-xs leading-relaxed text-muted">
          Answers are generated with Groq and researched with Exa.
        </p>
      </div>
    </div>
  );
}
