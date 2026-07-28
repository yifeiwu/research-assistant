"use client";

import { Composer } from "./Composer";
import type { ProviderSettings } from "@/lib/provider";

const EXAMPLE_PROMPTS = [
  "What are the most significant AI model releases this month?",
  "Compare the latest pricing of Vercel, Netlify, and Cloudflare Pages.",
  "Summarize recent research on retrieval-augmented generation.",
];

export function EmptyState({
  input,
  setInput,
  onSubmit,
  onExample,
  disabled,
  settings,
  onSettingsChange,
  onOpenSettings,
}: {
  input: string;
  setInput: (v: string) => void;
  onSubmit: () => void;
  onExample: (prompt: string) => void;
  disabled: boolean;
  settings: ProviderSettings;
  onSettingsChange: (next: ProviderSettings) => void;
  onOpenSettings: () => void;
}) {
  return (
    <main className="flex flex-1 flex-col items-center justify-center px-4">
      <div className="w-full max-w-2xl text-center">
        <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">
          Ask anything.
        </h2>
        <p className="mt-3 text-muted">
          On Medium and High effort I search with Exa and read the most relevant
          pages before answering, with sources. On Low effort I answer directly
          from what I already know.
        </p>

        <div className="mt-8 text-left">
          <Composer
            input={input}
            setInput={setInput}
            onSubmit={onSubmit}
            disabled={disabled}
            autoFocus
            settings={settings}
            onSettingsChange={onSettingsChange}
            onOpenSettings={onOpenSettings}
          />
        </div>

        <div className="mt-6 flex flex-wrap justify-center gap-2">
          {EXAMPLE_PROMPTS.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => onExample(p)}
              className="rounded-full border border-border bg-surface px-3.5 py-1.5 text-sm text-muted transition hover:border-accent hover:text-foreground"
            >
              {p}
            </button>
          ))}
        </div>
      </div>
    </main>
  );
}
