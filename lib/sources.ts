import { safeStringify } from "./json";

const URL_REGEX = /https?:\/\/[^\s)\]}"'<>]+/g;

function stripTrailingPunctuation(url: string): string {
  return url.replace(/[.,;:!?)\]}'"]+$/, "");
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
    const key = url.replace(/\/+$/, "");
    if (!seen.has(key)) {
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
 * Collect deduplicated source URLs referenced anywhere in an assistant
 * message: in the answer text and in the tool inputs/outputs.
 */
export function collectSources(message: { parts: MessagePart[] }): string[] {
  const urls: string[] = [];

  for (const part of message.parts) {
    if (part.type === "text" && typeof part.text === "string") {
      urls.push(...extractUrls(part.text));
    } else if (part.type === "dynamic-tool") {
      if (part.input != null) {
        urls.push(...extractUrls(safeStringify(part.input)));
      }
      if (part.output != null) {
        urls.push(
          ...extractUrls(
            typeof part.output === "string"
              ? part.output
              : safeStringify(part.output),
          ),
        );
      }
    }
  }

  return dedupeUrls(urls);
}
