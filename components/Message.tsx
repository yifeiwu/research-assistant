"use client";

import { useState } from "react";
import type { UIMessage } from "ai";
import { ToolStep, type DynamicToolPart } from "./ToolStep";
import { Markdown } from "./Markdown";
import { collectSources, domainOf, faviconFor } from "@/lib/sources";

export function Message({ message }: { message: UIMessage }) {
  const isUser = message.role === "user";

  const answerText = message.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("\n\n")
    .trim();

  const sources = isUser ? [] : collectSources(message);

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={
          isUser
            ? "max-w-[85%] rounded-2xl rounded-br-sm bg-accent px-4 py-2.5 text-white"
            : "w-full max-w-full"
        }
      >
        {message.parts.map((part, index) => {
          if (part.type === "text") {
            if (isUser) {
              return (
                <span key={index} className="whitespace-pre-wrap">
                  {part.text}
                </span>
              );
            }
            return (
              <Markdown key={index} className="prose-chat leading-relaxed">
                {part.text}
              </Markdown>
            );
          }

          if (part.type === "dynamic-tool") {
            return <ToolStep key={index} part={part as DynamicToolPart} />;
          }

          if (part.type === "step-start") {
            return index > 0 ? (
              <hr key={index} className="my-3 border-border/60" />
            ) : null;
          }

          return null;
        })}

        {!isUser && sources.length > 0 && <SourcesBar sources={sources} />}

        {!isUser && answerText.length > 0 && (
          <div className="mt-2">
            <CopyButton text={answerText} />
          </div>
        )}
      </div>
    </div>
  );
}

function SourcesBar({ sources }: { sources: string[] }) {
  return (
    <div className="mt-3 border-t border-border/60 pt-3">
      <div className="mb-2 text-xs font-medium tracking-wide text-muted uppercase">
        Sources
      </div>
      <div className="flex flex-wrap gap-2">
        {sources.map((url) => (
          <a
            key={url}
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            title={url}
            className="flex items-center gap-1.5 rounded-full border border-border bg-surface px-2.5 py-1 text-xs text-muted transition hover:border-accent hover:text-foreground"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={faviconFor(url)}
              alt=""
              width={14}
              height={14}
              className="rounded-sm"
              onError={(e) => {
                e.currentTarget.style.display = "none";
              }}
            />
            <span className="max-w-[14rem] truncate">{domainOf(url)}</span>
          </a>
        ))}
      </div>
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard may be unavailable; ignore
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-muted transition hover:bg-surface-2 hover:text-foreground"
      aria-label="Copy answer"
    >
      <span aria-hidden>{copied ? "✓" : "⧉"}</span>
      {copied ? "Copied" : "Copy"}
    </button>
  );
}
