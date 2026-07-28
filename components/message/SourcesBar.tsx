import { Globe } from "lucide-react";
import { domainOf } from "@/lib/sources";

export function SourcesBar({ sources }: { sources: string[] }) {
  return (
    <div className="mt-3 border-t border-border/60 pt-3">
      <div className="mb-2 text-xs font-medium tracking-wide text-muted uppercase">
        Sources
      </div>
      <div className="flex flex-wrap gap-2">
        {sources.map((url, i) => (
          <a
            key={url}
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            title={url}
            className="flex items-center gap-1.5 rounded-full border border-border bg-surface py-1 pr-2.5 pl-1 text-xs text-muted transition hover:border-accent hover:text-foreground"
          >
            <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-surface-2 text-[10px] font-medium text-accent-2">
              {i + 1}
            </span>
            <Globe className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />
            <span className="max-w-[14rem] truncate">{domainOf(url)}</span>
          </a>
        ))}
      </div>
    </div>
  );
}
