"use client";

import { GROQ_MODELS } from "@/lib/models";
import type { ProviderSettings } from "@/lib/provider";

export function SettingsPanel({
  settings,
  onChange,
  onClose,
}: {
  settings: ProviderSettings;
  onChange: (next: ProviderSettings) => void;
  onClose: () => void;
}) {
  const set = (patch: Partial<ProviderSettings>) =>
    onChange({ ...settings, ...patch });

  return (
    <>
      {/* click-outside backdrop */}
      <div className="fixed inset-0 z-10" onClick={onClose} aria-hidden />

      <div
        role="dialog"
        aria-label="Provider settings"
        className="absolute right-0 z-20 mt-2 w-[22rem] max-w-[90vw] rounded-2xl border border-border bg-surface p-4 text-sm shadow-2xl"
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-semibold">Model provider</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-2 py-0.5 text-muted hover:text-foreground"
            aria-label="Close settings"
          >
            ✕
          </button>
        </div>

        <div className="mb-4 grid grid-cols-2 gap-2">
          <ProviderTab
            label="Groq (free tier)"
            active={settings.provider === "groq"}
            onClick={() => set({ provider: "groq" })}
          />
          <ProviderTab
            label="Custom (OpenAI-compatible)"
            active={settings.provider === "custom"}
            onClick={() => set({ provider: "custom" })}
          />
        </div>

        {settings.provider === "groq" ? (
          <Field label="Model">
            <select
              value={settings.groqModel}
              onChange={(e) => set({ groqModel: e.target.value })}
              className="w-full cursor-pointer rounded-lg border border-border bg-surface-2 px-2.5 py-2 text-foreground outline-none focus:border-accent"
            >
              {GROQ_MODELS.map((m) => (
                <option key={m.id} value={m.id} className="bg-surface">
                  {m.label}
                  {m.hint ? ` — ${m.hint}` : ""}
                </option>
              ))}
            </select>
          </Field>
        ) : (
          <div className="space-y-3">
            <Field label="Base URL">
              <input
                type="url"
                inputMode="url"
                autoComplete="off"
                placeholder="https://api.openai.com/v1"
                value={settings.customBaseURL}
                onChange={(e) => set({ customBaseURL: e.target.value })}
                className="w-full rounded-lg border border-border bg-surface-2 px-2.5 py-2 text-foreground outline-none focus:border-accent"
              />
            </Field>
            <Field label="API key">
              <input
                type="password"
                autoComplete="off"
                placeholder="sk-..."
                value={settings.customApiKey}
                onChange={(e) => set({ customApiKey: e.target.value })}
                className="w-full rounded-lg border border-border bg-surface-2 px-2.5 py-2 text-foreground outline-none focus:border-accent"
              />
            </Field>
            <Field label="Model">
              <input
                type="text"
                autoComplete="off"
                placeholder="gpt-4o-mini"
                value={settings.customModel}
                onChange={(e) => set({ customModel: e.target.value })}
                className="w-full rounded-lg border border-border bg-surface-2 px-2.5 py-2 text-foreground outline-none focus:border-accent"
              />
            </Field>

            <p className="text-xs leading-relaxed text-muted">
              Must be an OpenAI Chat Completions-compatible endpoint that
              supports tool calling. Your key is stored only in this browser and
              sent to this app&apos;s server to make requests on your behalf.
            </p>
          </div>
        )}
      </div>
    </>
  );
}

function ProviderTab({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={
        "rounded-lg border px-3 py-2 text-left text-xs font-medium transition " +
        (active
          ? "border-accent bg-accent/10 text-foreground"
          : "border-border bg-surface-2 text-muted hover:text-foreground")
      }
    >
      {label}
    </button>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs text-muted">{label}</span>
      {children}
    </label>
  );
}
