import { safeStringify } from "./json";

export type CollectedSource = {
  url: string;
  title?: string;
};

const URL_REGEX = /https?:\/\/[^\s)\]}"'<>]+/g;
const MARKDOWN_LINK_REGEX = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
/** A markdown link's destination, allowing one level of brackets in the URL. */
const MARKDOWN_LINK_BALANCED_REGEX =
  /\]\((https?:\/\/[^\s)]+(?:\([^\s)]*\)[^\s)]*)*)\)/g;

function stripTrailingPunctuation(url: string): string {
  return url.replace(/[.,;:!?)\]}'"]+$/, "");
}

/**
 * Canonical comparison key for URL deduplication: lowercases/strips `www.`
 * from the host, drops the fragment and trailing path slashes, and removes
 * sentence punctuation stuck to the end, so `https://www.A.com/x/#f` and
 * `https://a.com/x` dedupe to the same source. Falls back to a plain string
 * cleanup for unparseable values.
 */
export function normalizeUrlKey(url: string): string {
  const cleaned = stripTrailingPunctuation(url.trim());
  try {
    const parsed = new URL(cleaned);
    parsed.hostname = parsed.hostname.replace(/^www\./i, "").toLowerCase();
    parsed.hash = "";
    const path = parsed.pathname.replace(/\/+$/, "") || "/";
    return `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}${path}${parsed.search}`;
  } catch {
    return cleaned.replace(/\/+$/, "");
  }
}

export function extractUrls(text: string): string[] {
  const matches = text.match(URL_REGEX) ?? [];
  return matches.map(stripTrailingPunctuation).filter(Boolean);
}


export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

type MessagePart = Record<string, unknown>;

/**
 * Collect deduplicated `{ url, title }` sources from an assistant message.
 *
 * Prefers structured `source-url` and `data-research-step` parts emitted by the
 * deterministic research pipeline, and falls back to markdown links / bare URLs
 * (plus legacy `dynamic-tool` parts) so saved conversations still render sources.
 */
export function collectSources(message: {
  parts: MessagePart[];
}): CollectedSource[] {
  const byKey = new Map<string, CollectedSource>();

  const add = (rawUrl: string, rawTitle?: string) => {
    const url = stripTrailingPunctuation(rawUrl.trim());
    const key = normalizeUrlKey(url);
    if (!key) return;
    const title = rawTitle?.trim() || undefined;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { url, title });
    } else if (!existing.title && title) {
      existing.title = title;
    }
  };

  for (const part of message.parts) {
    if (part.type === "source-url" && typeof part.url === "string") {
      add(
        part.url,
        typeof part.title === "string" ? part.title : undefined,
      );
      continue;
    }

    if (
      part.type === "data-research-step" &&
      part.data &&
      typeof part.data === "object"
    ) {
      const sources = (part.data as { sources?: unknown }).sources;
      if (Array.isArray(sources)) {
        for (const item of sources) {
          if (item && typeof item === "object") {
            const s = item as { url?: unknown; title?: unknown };
            if (typeof s.url === "string") {
              add(s.url, typeof s.title === "string" ? s.title : undefined);
            }
          }
        }
      }
      continue;
    }

    if (part.type === "text" && typeof part.text === "string") {
      for (const match of part.text.matchAll(MARKDOWN_LINK_REGEX)) {
        add(match[2], match[1]);
      }
      for (const url of extractUrls(part.text)) {
        add(url);
      }
      continue;
    }

    // Backwards compatibility for legacy saved conversations in localStorage.
    if (part.type === "dynamic-tool") {
      if (part.input != null) {
        for (const url of extractUrls(safeStringify(part.input))) {
          add(url);
        }
      }
      if (part.output != null) {
        const raw =
          typeof part.output === "string"
            ? part.output
            : safeStringify(part.output);
        for (const url of extractUrls(raw)) {
          add(url);
        }
      }
    }
  }

  return Array.from(byKey.values());
}

/**
 * Split a message's sources into the ones its answer text links to and the
 * rest (read during research, but not cited). Both keep their order.
 */
export function splitSourcesByCitation(
  message: { parts: MessagePart[] },
  sources: CollectedSource[] = collectSources(message),
): { cited: CollectedSource[]; other: CollectedSource[] } {
  const citedKeys = new Set<string>();
  for (const part of message.parts) {
    if (part.type !== "text" || typeof part.text !== "string") continue;
    // Link destinations first: unlike a bare URL, one may contain brackets.
    for (const match of part.text.matchAll(MARKDOWN_LINK_BALANCED_REGEX)) {
      citedKeys.add(normalizeUrlKey(match[1]));
    }
    for (const url of extractUrls(part.text)) citedKeys.add(normalizeUrlKey(url));
  }
  const cited: CollectedSource[] = [];
  const other: CollectedSource[] = [];
  for (const source of sources) {
    (citedKeys.has(normalizeUrlKey(source.url)) ? cited : other).push(source);
  }
  return { cited, other };
}
