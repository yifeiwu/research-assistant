import type { ChatMessage } from "./types/chat";

export type CollectedSource = {
  url: string;
  title?: string;
};

const URL_REGEX = /https?:\/\/[^\s)\]}"'<>]+/g;

/**
 * Markdown link `[label](url)` allowing one level of balanced parentheses in
 * the destination (e.g. `https://en.wikipedia.org/wiki/Foo_(bar)`).
 */
export const MARKDOWN_LINK_REGEX =
  /\[([^\]]+)\]\((https?:\/\/[^\s)]+(?:\([^\s)]*\)[^\s)]*)*)\)/g;

/** Split a candidate URL into the URL itself and trailing sentence punctuation. */
export function splitTrailingPunctuation(rawUrl: string): {
  url: string;
  suffix: string;
} {
  const match = rawUrl.match(/[.,;:!?)\]}'"]+$/);
  if (!match) return { url: rawUrl, suffix: "" };
  return { url: rawUrl.slice(0, -match[0].length), suffix: match[0] };
}

function stripTrailingPunctuation(url: string): string {
  return splitTrailingPunctuation(url).url;
}

const TRACKING_PARAM_NAMES = new Set([
  "fbclid",
  "gclid",
  "dclid",
  "msclkid",
  "yclid",
  "mc_cid",
  "mc_eid",
  "igshid",
  "ref_src",
  "_hsenc",
  "_hsmi",
]);

function isTrackingParam(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith("utm_") || TRACKING_PARAM_NAMES.has(lower);
}

/**
 * Canonical comparison key for URL deduplication: lowercases/strips `www.`
 * from the host, drops the fragment and trailing path slashes, strips common
 * analytics/tracking parameters, sorts remaining query parameters, and removes
 * trailing sentence punctuation.
 */
export function normalizeUrlKey(url: string): string {
  const cleaned = stripTrailingPunctuation(url.trim());
  try {
    const parsed = new URL(cleaned);
    parsed.hostname = parsed.hostname.replace(/^www\./i, "").toLowerCase();
    parsed.hash = "";
    for (const key of [...parsed.searchParams.keys()]) {
      if (isTrackingParam(key)) {
        parsed.searchParams.delete(key);
      }
    }
    parsed.searchParams.sort();
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

export type SourceBearingMessage = Pick<
  ChatMessage,
  "text" | "sources" | "steps"
>;

/**
 * Collect deduplicated `{ url, title }` sources from an assistant message.
 * Prefers structured `sources` and `steps` from the research pipeline, falling
 * back to markdown links and bare URLs in `text`.
 */
export function collectSources(message: SourceBearingMessage): CollectedSource[] {
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

  for (const s of message.sources ?? []) {
    add(s.url, s.title);
  }
  for (const step of message.steps ?? []) {
    for (const s of step.sources) {
      add(s.url, s.title);
    }
  }
  if (message.text) {
    for (const match of message.text.matchAll(MARKDOWN_LINK_REGEX)) {
      add(match[2], match[1]);
    }
    for (const url of extractUrls(message.text)) {
      add(url);
    }
  }

  return Array.from(byKey.values());
}

/**
 * Split a message's sources into those linked in `message.text` and the rest
 * read during research. Both preserve their discovery order.
 */
export function splitSourcesByCitation(
  message: SourceBearingMessage,
  sources: CollectedSource[] = collectSources(message),
): { cited: CollectedSource[]; other: CollectedSource[] } {
  const citedKeys = new Set<string>();
  if (message.text) {
    for (const match of message.text.matchAll(MARKDOWN_LINK_REGEX)) {
      citedKeys.add(normalizeUrlKey(match[2]));
    }
    for (const url of extractUrls(message.text)) {
      citedKeys.add(normalizeUrlKey(url));
    }
  }
  const cited: CollectedSource[] = [];
  const other: CollectedSource[] = [];
  for (const source of sources) {
    (citedKeys.has(normalizeUrlKey(source.url)) ? cited : other).push(source);
  }
  return { cited, other };
}
