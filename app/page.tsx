"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useEffect, useRef, useState } from "react";
import { Message } from "@/components/Message";
import { GROQ_MODELS } from "@/lib/models";
import {
  DEFAULT_PROVIDER_SETTINGS,
  type ProviderSettings,
} from "@/lib/provider";
import { SettingsPanel } from "@/components/SettingsPanel";

const SETTINGS_STORAGE_KEY = "research-assistant-settings";

const EXAMPLE_PROMPTS = [
  "What are the most significant AI model releases this month?",
  "Compare the latest pricing of Vercel, Netlify, and Cloudflare Pages.",
  "Summarize recent research on retrieval-augmented generation.",
];

export default function Home() {
  const { messages, sendMessage, status, error, stop, setMessages } = useChat({
    transport: new DefaultChatTransport({ api: "/api/chat" }),
  });

  const [input, setInput] = useState("");
  const [settings, setSettings] = useState<ProviderSettings>(
    DEFAULT_PROVIDER_SETTINGS,
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const isBusy = status === "submitted" || status === "streaming";
  const hasMessages = messages.length > 0;

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
      if (saved) {
        setSettings({ ...DEFAULT_PROVIDER_SETTINGS, ...JSON.parse(saved) });
      }
    } catch {
      // ignore malformed storage
    }
  }, []);

  function updateSettings(next: ProviderSettings) {
    setSettings(next);
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(next));
  }

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages]);

  function requestBody() {
    if (settings.provider === "custom") {
      return {
        provider: {
          type: "custom" as const,
          baseURL: settings.customBaseURL.trim(),
          apiKey: settings.customApiKey.trim(),
          model: settings.customModel.trim(),
        },
      };
    }
    return { model: settings.groqModel };
  }

  function submit(text: string) {
    const trimmed = text.trim();
    if (!trimmed || isBusy) return;
    sendMessage({ text: trimmed }, { body: requestBody() });
    setInput("");
  }

  function newChat() {
    if (isBusy) stop();
    setMessages([]);
    setInput("");
  }

  return (
    <div className="flex h-dvh flex-col bg-background">
      <header className="flex items-center gap-2 border-b border-border px-5 py-3">
        <span className="text-lg">🧭</span>
        <h1 className="text-base font-semibold tracking-tight">
          Research Assistant
        </h1>
        <span className="ml-2 hidden text-xs text-muted sm:inline">
          powered by Groq + Exa
        </span>
        <div className="ml-auto flex items-center gap-2">
          {hasMessages && (
            <button
              type="button"
              onClick={newChat}
              className="rounded-lg border border-border bg-surface px-3 py-1.5 text-xs text-foreground transition hover:border-accent"
            >
              + New chat
            </button>
          )}
          <div className="relative">
            <button
              type="button"
              onClick={() => setSettingsOpen((o) => !o)}
              className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-1.5 text-xs text-foreground transition hover:border-accent"
              aria-haspopup="dialog"
              aria-expanded={settingsOpen}
            >
              <span aria-hidden>⚙</span>
              <span className="max-w-[40vw] truncate sm:max-w-[16rem]">
                {currentModelLabel(settings)}
              </span>
            </button>
            {settingsOpen && (
              <SettingsPanel
                settings={settings}
                onChange={updateSettings}
                onClose={() => setSettingsOpen(false)}
              />
            )}
          </div>
        </div>
      </header>

      {!hasMessages ? (
        <main className="flex flex-1 flex-col items-center justify-center px-4">
          <div className="w-full max-w-2xl text-center">
            <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">
              Ask anything. I&apos;ll research the web.
            </h2>
            <p className="mt-3 text-muted">
              I search with Exa and read the most relevant pages before
              answering, with sources.
            </p>

            <div className="mt-8">
              <PromptBox
                input={input}
                setInput={setInput}
                onSubmit={() => submit(input)}
                disabled={isBusy}
                autoFocus
              />
            </div>

            <div className="mt-6 flex flex-wrap justify-center gap-2">
              {EXAMPLE_PROMPTS.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => submit(p)}
                  className="rounded-full border border-border bg-surface px-3.5 py-1.5 text-sm text-muted transition hover:border-accent hover:text-foreground"
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
        </main>
      ) : (
        <>
          <main ref={scrollRef} className="flex-1 overflow-y-auto">
            <div className="mx-auto flex max-w-3xl flex-col gap-5 px-4 py-6">
              {messages.map((message) => (
                <Message key={message.id} message={message} />
              ))}

              {status === "submitted" && (
                <div className="flex items-center gap-2 text-sm text-muted">
                  <span className="loading-dot text-accent">●</span>
                  Thinking…
                </div>
              )}

              {error && (
                <div className="rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300">
                  Something went wrong: {error.message}. Make sure
                  GROQ_API_KEY and EXA_API_KEY are set.
                </div>
              )}
            </div>
          </main>

          <div className="border-t border-border bg-background px-4 py-3">
            <div className="mx-auto max-w-3xl">
              <PromptBox
                input={input}
                setInput={setInput}
                onSubmit={() => submit(input)}
                onStop={stop}
                disabled={false}
                busy={isBusy}
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function currentModelLabel(settings: ProviderSettings): string {
  if (settings.provider === "custom") {
    return settings.customModel.trim() || "Custom endpoint";
  }
  const found = GROQ_MODELS.find((m) => m.id === settings.groqModel);
  return found?.label ?? settings.groqModel;
}

function PromptBox({
  input,
  setInput,
  onSubmit,
  onStop,
  disabled,
  busy,
  autoFocus,
}: {
  input: string;
  setInput: (v: string) => void;
  onSubmit: () => void;
  onStop?: () => void;
  disabled?: boolean;
  busy?: boolean;
  autoFocus?: boolean;
}) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
      className="flex items-end gap-2 rounded-2xl border border-border bg-surface p-2 focus-within:border-accent"
    >
      <textarea
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
        className="max-h-40 flex-1 resize-none bg-transparent px-2 py-1.5 text-foreground outline-none placeholder:text-muted"
      />
      {busy && onStop ? (
        <button
          type="button"
          onClick={onStop}
          className="rounded-xl bg-surface-2 px-4 py-2 text-sm font-medium text-foreground transition hover:bg-border"
        >
          Stop
        </button>
      ) : (
        <button
          type="submit"
          disabled={disabled || !input.trim()}
          className="rounded-xl bg-accent px-4 py-2 text-sm font-medium text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Send
        </button>
      )}
    </form>
  );
}
