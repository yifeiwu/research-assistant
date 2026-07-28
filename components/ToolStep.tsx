"use client";

import { useState } from "react";
import {
  ChevronDown,
  FileText,
  Globe,
  Search,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { Markdown } from "./Markdown";
import { dedupeUrls, domainOf, extractUrls } from "@/lib/sources";
import { mcpOutputToText } from "@/lib/mcp-output";

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

function toolLabel(toolName: string): { verb: string; icon: LucideIcon } {
  switch (toolName) {
    case "web_search_exa":
    case "web_search_advanced_exa":
      return { verb: "Searching the web", icon: Search };
    case "web_fetch_exa":
      return { verb: "Reading page", icon: FileText };
    default:
      return { verb: toolName, icon: Wrench };
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

export function ToolStep({ part }: { part: DynamicToolPart }) {
  const [open, setOpen] = useState(false);
  const { verb, icon: Icon } = toolLabel(part.toolName);
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
    part.state === "output-available"
      ? mcpOutputToText(part.output, { pretty: true })
      : "";

  const outputUrls = dedupeUrls(extractUrls(outputText)).slice(0, 8);

  return (
    <div className="my-2 rounded-xl border border-border bg-surface-2/60 text-sm">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        <Icon className="h-4 w-4 shrink-0 text-muted" aria-hidden />
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
            <ChevronDown
              className={
                "h-4 w-4 text-muted transition-transform " +
                (open ? "rotate-180" : "")
              }
              aria-hidden
            />
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
          {outputUrls.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {outputUrls.map((url) => (
                <a
                  key={url}
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={url}
                  className="flex items-center gap-1 rounded-full border border-border bg-surface px-2 py-0.5 text-[11px] text-muted transition hover:border-accent hover:text-foreground"
                >
                  <Globe className="h-3 w-3 shrink-0 text-muted" aria-hidden />
                  <span className="max-w-[12rem] truncate">{domainOf(url)}</span>
                </a>
              ))}
            </div>
          )}
          <Markdown className="prose-chat text-xs leading-relaxed">
            {outputText}
          </Markdown>
        </div>
      )}
    </div>
  );
}
