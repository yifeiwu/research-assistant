"use client";

import { useState } from "react";
import { Markdown } from "./Markdown";

type ToolState =
  | "input-streaming"
  | "input-available"
  | "output-available"
  | "output-error";

export type DynamicToolPart = {
  type: "dynamic-tool";
  toolName: string;
  toolCallId: string;
  state: ToolState;
  input?: unknown;
  output?: unknown;
  errorText?: string;
};

function toolLabel(toolName: string): { verb: string; icon: string } {
  switch (toolName) {
    case "web_search_exa":
    case "web_search_advanced_exa":
      return { verb: "Searching the web", icon: "🔍" };
    case "web_fetch_exa":
      return { verb: "Reading page", icon: "📄" };
    default:
      return { verb: toolName, icon: "🛠️" };
  }
}

function getQuery(input: unknown): string | null {
  if (input && typeof input === "object") {
    const obj = input as Record<string, unknown>;
    if (typeof obj.query === "string") return obj.query;
    if (typeof obj.url === "string") return obj.url;
    if (Array.isArray(obj.urls)) return obj.urls.join(", ");
  }
  return null;
}

function stringifyOutput(output: unknown): string {
  if (output == null) return "";
  if (typeof output === "string") return output;
  // MCP tool results are usually { content: [{ type: 'text', text }] }
  if (typeof output === "object") {
    const obj = output as Record<string, unknown>;
    if (Array.isArray(obj.content)) {
      const text = obj.content
        .map((c) =>
          c && typeof c === "object" && "text" in c
            ? String((c as Record<string, unknown>).text)
            : "",
        )
        .join("\n");
      if (text.trim()) return text;
    }
  }
  try {
    return JSON.stringify(output, null, 2);
  } catch {
    return String(output);
  }
}

export function ToolStep({ part }: { part: DynamicToolPart }) {
  const [open, setOpen] = useState(false);
  const { verb, icon } = toolLabel(part.toolName);
  const query = getQuery(part.input);

  const isRunning =
    part.state === "input-streaming" || part.state === "input-available";
  const isError = part.state === "output-error";

  let statusText = "";
  if (part.state === "input-streaming") statusText = "preparing…";
  else if (part.state === "input-available") statusText = "running…";
  else if (part.state === "output-available") statusText = "done";
  else if (part.state === "output-error") statusText = "failed";

  const outputText =
    part.state === "output-available" ? stringifyOutput(part.output) : "";

  return (
    <div className="my-2 rounded-xl border border-border bg-surface-2/60 text-sm">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        <span className="text-base">{icon}</span>
        <span className="font-medium text-foreground">{verb}</span>
        {query && (
          <span className="truncate text-muted">
            {" "}
            — <span className="text-accent-2">{query}</span>
          </span>
        )}
        <span className="ml-auto flex items-center gap-2 whitespace-nowrap">
          {isRunning && (
            <span className="loading-dot text-accent">●</span>
          )}
          <span
            className={
              isError
                ? "text-red-400"
                : isRunning
                  ? "text-accent"
                  : "text-muted"
            }
          >
            {statusText}
          </span>
          {(outputText || isError) && (
            <span className="text-muted">{open ? "▲" : "▼"}</span>
          )}
        </span>
      </button>

      {open && isError && (
        <div className="border-t border-border px-3 py-2 text-red-400">
          {part.errorText ?? "Tool execution failed."}
        </div>
      )}

      {open && outputText && (
        <div className="max-h-72 overflow-auto border-t border-border px-3 py-2 text-muted">
          <Markdown className="prose-chat text-xs leading-relaxed">
            {outputText}
          </Markdown>
        </div>
      )}
    </div>
  );
}
