import {
  MARKDOWN_LINK_REGEX,
  normalizeUrlKey,
  splitTrailingPunctuation,
} from "./sources";
import type { ResearchSource } from "./types/chat";

const BARE_URL_SOURCE = String.raw`https?:\/\/[^\s<>"'()[\]]+(?:\([^\s<>"'()]*\)[^\s<>"'()[\]]*)*`;
const CITATION_TOKEN_REGEX = new RegExp(
  `${MARKDOWN_LINK_REGEX.source}|(${BARE_URL_SOURCE})`,
  "g",
);

function canonicalCitationKey(rawUrl: string): string {
  // Candidates scraped from prose often carry trailing sentence punctuation
  // ("...see https://example.com/a.") that isn't part of the URL; strip it
  // before canonicalising or valid citations never match the allowlist.
  return normalizeUrlKey(splitTrailingPunctuation(rawUrl.trim()).url);
}

function verifySegment(
  segment: string,
  allowed: Set<string>,
  stats: { stripped: number },
): string {
  return segment.replace(
    CITATION_TOKEN_REGEX,
    (match, mdLabel?: string, mdUrl?: string, bareUrl?: string) => {
      if (mdLabel !== undefined && mdUrl !== undefined) {
        if (allowed.has(canonicalCitationKey(mdUrl))) {
          return match;
        }
        stats.stripped += 1;
        return mdLabel;
      }
      if (bareUrl !== undefined) {
        const { url: cleaned, suffix } = splitTrailingPunctuation(bareUrl);
        if (allowed.has(canonicalCitationKey(cleaned))) {
          return cleaned + suffix;
        }
        stats.stripped += 1;
        return suffix;
      }
      return match;
    },
  );
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
): { text: string; strippedCount: number } {
  const allowed = new Set(
    sources.map((s) => canonicalCitationKey(typeof s === "string" ? s : s.url)),
  );
  const stats = { stripped: 0 };
  const segments = text.split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/g);
  const out = segments
    .map((segment, i) =>
      i % 2 === 1 ? segment : verifySegment(segment, allowed, stats),
    )
    .join("");
  return { text: out, strippedCount: stats.stripped };
}
