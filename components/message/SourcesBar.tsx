import { Globe } from "lucide-react";
import { domainOf, type CollectedSource } from "@/lib/sources";

function SourceChip({
  source,
  number,
}: {
  source: CollectedSource;
  /** Shown on sources the answer cites. */
  number?: number;
}) {
  const domain = domainOf(source.url);
  const hasDistinctTitle =
    Boolean(source.title) &&
    source.title!.toLowerCase() !== domain.toLowerCase();

  return (
    <a
      href={source.url}
      target="_blank"
      rel="noopener noreferrer"
      title={source.title ? `${source.title} — ${source.url}` : source.url}
      className={
        "flex items-center gap-1.5 rounded-full border border-border bg-surface py-1 pr-2.5 text-xs text-muted transition hover:border-accent hover:text-foreground " +
        (number != null ? "pl-1" : "pl-2")
      }
    >
      {number != null && (
        <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-surface-2 text-[10px] font-medium text-accent-2">
          {number}
        </span>
      )}
      <Globe className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />
      <span
        className={
          "max-w-[14rem] truncate " + (number != null ? "text-foreground/90" : "")
        }
      >
        {hasDistinctTitle ? source.title : domain}
      </span>
      {hasDistinctTitle && (
        <span className="max-w-[8rem] truncate text-muted/70">· {domain}</span>
      )}
    </a>
  );
}

function SourceGroup({
  label,
  sources,
  numbered,
}: {
  label: string;
  sources: CollectedSource[];
  numbered: boolean;
}) {
  return (
    <div>
      <div className="mb-2 text-xs font-medium tracking-wide text-muted uppercase">
        {label}
      </div>
      <div className="flex flex-wrap gap-2">
        {sources.map((source, i) => (
          <SourceChip
            key={source.url}
            source={source}
            number={numbered ? i + 1 : undefined}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * The one list of a message's sources (the answer itself is asked not to
 * repeat it): those the answer links to first, then anything else that was
 * read. `other` on its own is everything, for an answer that links to none.
 */
export function SourcesBar({
  cited,
  other,
}: {
  cited: CollectedSource[];
  other: CollectedSource[];
}) {
  return (
    <div className="mt-3 space-y-3 border-t border-border/60 pt-3">
      {cited.length > 0 && <SourceGroup label="Sources" sources={cited} numbered />}
      {other.length > 0 && (
        <SourceGroup
          label={cited.length > 0 ? "Also read" : "Sources"}
          sources={other}
          numbered={cited.length === 0}
        />
      )}
    </div>
  );
}
