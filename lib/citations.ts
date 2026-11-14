import { normalizeUrlKey } from "./sources";
import type { ResearchSource } from "./types/chat";

// Markdown link destinations allow one level of balanced parentheses so
// URLs like https://en.wikipedia.org/wiki/Foo_(bar) aren't truncated at ")".
const MARKDOWN_LINK =
  /\[([^\]]+)\]\((https?:\/\/[^\s)]+(?:\([^\s)]*\)[^\s)]*)*)\)/g;
const BARE_URL = /https?:\/\/[^\s<>"')\]]+/g;

/** Split a candidate URL into the URL itself and trailing sentence punctuation. */
function splitTrailingPunctuation(rawUrl: string): { url: string; suffix: string } {
  const match = rawUrl.match(/[.,;:!?]+$/);
  if (!match) return { url: rawUrl, suffix: "" };
  return { url: rawUrl.slice(0, -match[0].length), suffix: match[0] };
}

function canonicalCitationKey(rawUrl: string): string {
  // Candidates scraped from prose often carry trailing sentence punctuation
  // ("...see https://example.com/a.") that isn't part of the URL; strip it
  // before canonicalising or valid citations never match the allowlist.
  return normalizeUrlKey(splitTrailingPunctuation(rawUrl.trim()).url);
}

function verifySegment(
  segment: string,
  allowed: Set<string>,
  stats: { stripped: number; verified: number },
): string {
  const withoutMarkdown = segment.replace(MARKDOWN_LINK, (match, label: string, url: string) => {
    if (allowed.has(canonicalCitationKey(url))) {
      stats.verified += 1;
      return match;
    }
    stats.stripped += 1;
    return label;
  });
  return withoutMarkdown.replace(BARE_URL, (url) => {
    const { url: cleaned, suffix } = splitTrailingPunctuation(url);
    if (allowed.has(canonicalCitationKey(cleaned))) {
      stats.verified += 1;
      // Keep the sentence punctuation, but not glued to the URL.
      return cleaned + suffix;
    }
    stats.stripped += 1;
    return suffix;
  });
}

/**
 * De-link any citation whose URL was not retrieved this turn. Markdown labels
 * are kept as plain text; invented bare URLs are removed. Fenced code blocks
 * and inline code spans are left untouched (URLs there are examples, not
 * citations).
 */
export function verifyCitations(
  text: string,
  sources: ResearchSource[] | string[],
): { text: string; strippedCount: number; verifiedCount: number } {
  const allowed = new Set(
    sources.map((s) => canonicalCitationKey(typeof s === "string" ? s : s.url)),
  );
  const stats = { stripped: 0, verified: 0 };
  const segments = text.split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/g);
  const out = segments
    .map((segment, i) =>
      i % 2 === 1 ? segment : verifySegment(segment, allowed, stats),
    )
    .join("");
  return { text: out, strippedCount: stats.stripped, verifiedCount: stats.verified };
}
