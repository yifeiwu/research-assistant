import { safeStringify } from "./json";

export type CollectedSource = {
  url: string;
  title?: string;
};

const URL_REGEX = /https?:\/\/[^\s)\]}"'<>]+/g;
const MARKDOWN_LINK_REGEX = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;

function stripTrailingPunctuation(url: string): string {
  return url.replace(/[.,;:!?)\]}'"]+$/, "");
}

/** Canonical comparison key for URL deduplication (strips trailing slashes). */
export function normalizeUrlKey(url: string): string {
  return stripTrailingPunctuation(url.trim()).replace(/\/+$/, "");
}

export function extractUrls(text: string): string[] {
  const matches = text.match(URL_REGEX) ?? [];
  return matches.map(stripTrailingPunctuation).filter(Boolean);
}

/** Dedupe URLs, treating trailing slashes as equivalent; preserves order. */
export function dedupeUrls(urls: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const url of urls) {
    const key = normalizeUrlKey(url);
    if (key && !seen.has(key)) {
      seen.add(key);
      out.push(url);
    }
  }
  return out;
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
