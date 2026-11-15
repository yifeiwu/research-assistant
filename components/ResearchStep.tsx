"use client";

import { useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  ChevronDown,
  Compass,
  FileText,
  Globe,
  Search,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import { Markdown } from "./Markdown";
import { domainOf } from "@/lib/sources";
import type { ResearchStepData } from "@/lib/types/chat";

function pluralize(count: number, singular: string): string {
  return `${count} ${count === 1 ? singular : `${singular}s`}`;
}

function stepPresentation(data: ResearchStepData): {
  icon: LucideIcon;
  title: string;
  status: string;
  running: boolean;
  failed: boolean;
} {
  const isFollowUp = data.round > 1;
  const sCount = data.sources.length;

  switch (data.phase) {
    case "planning":
      return {
        icon: Compass,
        title: "Planning search",
        status: "planning…",
        running: true,
        failed: false,
      };
    case "searching":
      return {
        icon: Search,
        title: isFollowUp ? "Follow-up search" : "Searching the web",
        status: "searching…",
        running: true,
        failed: false,
      };
    case "reranking":
      return {
        icon: Compass,
        title: "Selecting highest-authority sources",
        status: "reranking…",
        running: true,
        failed: false,
      };
    case "reading":
      return {
        icon: FileText,
        title: isFollowUp
          ? `Reading ${pluralize(sCount, "follow-up source")}`
          : `Reading ${pluralize(sCount, "source")}`,
        status: "condensing…",
        running: true,
        failed: false,
      };
    case "checking-gaps":
      return {
        icon: Sparkles,
        title: `Evaluating ${pluralize(sCount, "source")} for gaps`,
        status: "checking…",
        running: true,
        failed: false,
      };
    case "synthesizing":
      return {
        icon: Sparkles,
        title: "Distilling cross-round research brief",
        status: "distilling…",
        running: true,
        failed: false,
      };
    case "error":
      return {
        icon: AlertCircle,
        title: "Web search returned no sources",
        status: "failed",
        running: false,
        failed: true,
      };
    case "done": {
      const prefix = isFollowUp ? "Follow-up research" : "Researched";
      const title =
        sCount > 0
          ? `${prefix} · ${pluralize(sCount, "source")}`
          : `${prefix} (0 new sources)`;
      return {
        icon: Search,
        title,
        status: "done",
        running: false,
        failed: false,
      };
    }
  }
}

export function ResearchStep({ data }: { data: ResearchStepData }) {
  const [open, setOpen] = useState(false);

  // When the query planner determines no web search is needed (`NO_SEARCH`),
  // collapse cleanly once complete so direct answers have no empty card.
  if (
    data.phase === "done" &&
    !data.query &&
    data.sources.length === 0 &&
    !data.notes
  ) {
    return null;
  }

  const { icon: Icon, title, status, running, failed } = stepPresentation(data);
  const hasDetails =
    Boolean(data.query) ||
    data.sources.length > 0 ||
    Boolean(data.notes) ||
    Boolean(data.error);

  const previewQuery = running && data.query ? data.query : null;

  return (
    <div className="my-2 rounded-xl border border-border bg-surface-2/60 text-sm">
      <button
        type="button"
        onClick={() => hasDetails && setOpen((o) => !o)}
        disabled={!hasDetails}
        aria-expanded={hasDetails ? open : undefined}
        className="flex w-full items-center gap-2 px-3 py-2 text-left disabled:cursor-default"
      >
        <Icon className="h-4 w-4 shrink-0 text-muted" aria-hidden />
        <span className="font-medium text-foreground">{title}</span>
        {previewQuery && (
          <span className="truncate text-muted">
            {" "}
            — <span className="text-accent-2">{previewQuery}</span>
          </span>
        )}
        <span className="ml-auto flex items-center gap-2 whitespace-nowrap">
          {running && <span className="loading-dot text-accent">●</span>}
          <span
            className={
              failed
                ? "text-red-400"
                : running
                  ? "text-accent"
                  : "text-muted"
            }
          >
            {status}
          </span>
          {hasDetails && (
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

      {data.degraded && (data.phase === "done" || data.phase === "error") && (
        <div className="flex items-start gap-1.5 border-t border-border px-3 py-2 text-xs text-amber-300">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>
            Some sources couldn&apos;t be retrieved — the answer may be
            incomplete. ({data.degraded.messages.join("; ")})
          </span>
        </div>
      )}

      {open && hasDetails && (
        <div className="max-h-80 space-y-3 overflow-auto border-t border-border px-3 py-2.5 text-xs text-muted">
          {data.error && <div className="text-red-400">{data.error}</div>}
          {data.degraded && (
            <div className="text-amber-300">
              Partial research: {data.degraded.messages.join("; ")}.
            </div>
          )}

          {data.query && (
            <div>
              <div className="mb-1.5 text-[11px] font-medium tracking-wide text-muted/80 uppercase">
                Query
              </div>
              <span className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-0.5 text-[11px] text-accent-2">
                <Search className="h-3 w-3 shrink-0 text-muted" aria-hidden />
                <span>{data.query}</span>
              </span>
            </div>
          )}

          {data.sources.length > 0 && (
            <div>
              <div className="mb-1.5 text-[11px] font-medium tracking-wide text-muted/80 uppercase">
                Sources read
              </div>
              <div className="flex flex-wrap gap-1.5">
                {data.sources.map((src) => {
                  const domain = domainOf(src.url);
                  return (
                    <a
                      key={src.url}
                      href={src.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={src.title ? `${src.title} — ${src.url}` : src.url}
                      className="flex items-center gap-1 rounded-full border border-border bg-surface px-2 py-0.5 text-[11px] text-muted transition hover:border-accent hover:text-foreground"
                    >
                      <Globe
                        className="h-3 w-3 shrink-0 text-muted"
                        aria-hidden
                      />
                      <span className="max-w-[14rem] truncate">
                        {src.title || domain}
                      </span>
                    </a>
                  );
                })}
              </div>
            </div>
          )}

          {data.notes && (
            <div>
              <div className="mb-1.5 text-[11px] font-medium tracking-wide text-muted/80 uppercase">
                Condensed notes
              </div>
              <Markdown className="prose-chat text-xs leading-relaxed">
                {data.notes}
              </Markdown>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
