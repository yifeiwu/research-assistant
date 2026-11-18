import "server-only";
import { createAbortError, isAbortError } from "./errors";
import type { ExaDocument } from "./exa";
import { logDebug, logError } from "./logger";
import { serverConfig } from "./config";
import {
  fitSummaryOutputTokens,
  maxSummaryBatchInputChars,
} from "./models";
import { normalizeCacheText, requestCache, type RequestCache } from "./cache";
import { domainOf } from "./sources";
import { generateAuxiliaryText, type StageRunner } from "./agent/stage";

const PASSTHROUGH_CHAR_LIMIT = serverConfig.summary.passthroughCharLimit;
const BATCH_INPUT_CHAR_CAP = serverConfig.summary.batchInputCharCap;
const PER_SOURCE_INPUT_CHAR_CAP = serverConfig.summary.perSourceInputCharCap;
const FALLBACK_CHAR_CAP = serverConfig.summary.fallbackCharCap;

/**
 * Strip leading `<think>...</think>` preamble blocks emitted by open-weight
 * reasoning models on OpenAI-compatible endpoints without eating literal
 * `<think>` mentions inside user-visible prose or code blocks.
 */
export function stripThinking(text: string): string {
  return text
    .replace(/^\s*(?:<think>[\s\S]*?<\/think>\s*)+/i, "")
    .replace(/^\s*<think>[\s\S]*$/i, "")
    .trim();
}

const IRRELEVANT_NOTE_RE =
  /(?:^|\n)\s*-\s*Irrelevant to research question\.?\s*$/i;

export function isIrrelevantNote(note: string): boolean {
  return IRRELEVANT_NOTE_RE.test(note.trim());
}

function formatSourceHeader(doc: ExaDocument): string {
  return [
    `### ${doc.title ?? doc.url}`,
    `URL: ${doc.url}`,
    `Domain: ${domainOf(doc.url)} | Published: ${doc.publishedDate ?? "unlisted"}`,
  ].join("\n");
}

/**
 * Build a compact source excerpt from Exa's neural `highlights` (plus bounded
 * lead text when available), falling back to raw text when highlights are absent.
 */
export function formatDocExcerpt(doc: ExaDocument, maxChars: number): string {
  if (maxChars <= 0) return "";
  const highlights = (doc.highlights ?? [])
    .map((h) => h.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const rawBody = doc.text.trim();

  if (highlights.length === 0) {
    return rawBody.slice(0, maxChars);
  }

  const highlightText = highlights.map((h) => `- ${h}`).join("\n");
  if (!rawBody || highlightText.length >= maxChars - 160) {
    return highlightText.slice(0, maxChars);
  }

  const leadBudget = Math.min(600, maxChars - highlightText.length - 20);
  const lead = rawBody.slice(0, leadBudget).trim();
  return `${highlightText}\n\nLead context:\n${lead}`.slice(0, maxChars);
}

const SUMMARY_SYSTEM_PROMPT = `You compress web source excerpts into high-density, critically evaluated research notes.

Rules:
- If a source contains NO information relevant to the research question, output ONLY the single bullet:
  - Irrelevant to research question.
- For relevant sources, output:
  1. First bullet: \`- Profile: <peer-reviewed | official-docs | news | vendor | blog/forum> | Caveat: <concise reliability caveat or none>\` (flag vendor/promotional framing, missing citations, small/unrepresentative samples, outdated data, or conflicts of interest).
  2. Up to 5 dense factual bullets packing maximum empirical signal per token: exact figures, percentages, units, sample sizes/conditions, dates, named entities, causal mechanisms, and methodological scope.
- Tag verifiable empirical data or official specs with \`[Fact]\` and single-source assertions, forecasts, or opinions with \`[Claim]\` rather than writing wordy attribution filler.
- Note unsupported leaps or missing baselines concisely when claims outrun presented evidence.
- Output plain text bullet points only. No JSON, no tool calls, no intro/outro prose.
- Condense each source separately under its own "### Source N" heading (N matching the given source number), in order. Never merge facts across sources.`;

type CondenseSourceOutcome = { note: string; usedFallback: boolean };

export type CondenseOpts = {
  stage: StageRunner;
  query: string;
  batchSize?: number;
  deep?: boolean;
  perSourceCharCap?: number;
  /** Spend extra time budget to retry any missed/failed sources individually after pacing. */
  retryMissing?: boolean;
  deadlineAt?: number;
  signal?: AbortSignal;
  requestId?: string;
  cache?: RequestCache;
  disableCache?: boolean;
};

const BATCH_SOURCE_HEADING_RE =
  /^(?:#{1,6}[ \t]*(?:\*{1,2})?Source[ \t]+(\d+):?(?:\*{1,2})?(?:[ \t]*[:—–\-([][^\r\n]*|[ \t]*)|(?:\*{1,2}Source[ \t]+(\d+):?\*{1,2}|Source[ \t]+(\d+):)[^\r\n]*|<source[ \t]+(\d+)>[^\r\n]*)$/gim;

/**
 * Split a batched summarizer response into per-source notes. Sections are
 * headed `### Source N` (tolerating minor model formatting drift such as
 * `### Source 1: Title`, `## Source 1`, `**Source 1**`, or `<source 1>`);
 * single-source calls that omit the heading altogether are also accepted.
 */
export function parseBatchNotes(raw: string, count: number): (string | null)[] {
  const cleaned = stripThinking(raw);
  if (!cleaned) return Array.from({ length: count }, () => null);

  const sections = new Map<number, string>();
  const matches = [...cleaned.matchAll(BATCH_SOURCE_HEADING_RE)];

  if (matches.length === 0 && count === 1) {
    const body = cleaned.replace(/<\/?source\s+\d+>/gi, "").trim();
    return [body || null];
  }

  for (const [i, match] of matches.entries()) {
    const numRaw = match[1] ?? match[2] ?? match[3] ?? match[4];
    const n = Number.parseInt(numRaw, 10);
    if (!Number.isFinite(n) || n < 1 || n > count || sections.has(n)) continue;
    const start = (match.index ?? 0) + match[0].length;
    const end = i + 1 < matches.length ? (matches[i + 1].index ?? cleaned.length) : cleaned.length;
    const body = cleaned
      .slice(start, end)
      .replace(/<\/source\s+\d+>\s*$/i, "")
      .trim();
    if (body) sections.set(n, body);
  }
  return Array.from({ length: count }, (_, i) => sections.get(i + 1) ?? null);
}

function buildBatchPrompt(
  query: string,
  entries: { doc: ExaDocument; input: string }[],
  deep: boolean,
): string {
  const blocks = entries.map(
    ({ doc, input }, i) =>
      `<source ${i + 1}>\nTitle: ${doc.title ?? doc.url}\nURL: ${doc.url}${doc.publishedDate ? `\nPublished: ${doc.publishedDate}` : ""}\nContent:\n"""\n${input}\n"""\n</source ${i + 1}>`,
  );
  const bulletAllowance = deep ? 7 : 5;
  return [
    `Research question:\n${query || "(not provided)"}`,
    "",
    `Condense EACH of the ${entries.length} sources below. For irrelevant sources output only "- Irrelevant to research question." so relevant sources get full detail (1 "- Profile: ... | Caveat: ..." bullet + up to ${bulletAllowance} dense bullets with exact metrics, dates, conditions, and [Fact]/[Claim] tags).`,
    `Output exactly one section per source, in order, headed "### Source N" (N = the source number), with no introduction or conclusion.`,
    "",
    ...blocks,
  ].join("\n");
}

export type CondenseSourcesOutcome = {
  notes: string[];
  fallbackCount: number;
};

/**
 * The "map" step for a round of documents. Short excerpts pass through
 * verbatim; larger excerpts are condensed in batched summarizer-pool calls.
 */
export async function condenseSourcesDetailed(
  docs: ExaDocument[],
  opts: CondenseOpts,
): Promise<CondenseSourcesOutcome> {
  const maxSourceCap = opts.perSourceCharCap ?? PER_SOURCE_INPUT_CHAR_CAP;
  const outcomes: (CondenseSourceOutcome | undefined)[] = docs.map(() => undefined);
  const pending: { index: number; doc: ExaDocument; header: string; excerpt: string }[] = [];

  docs.forEach((doc, index) => {
    const header = formatSourceHeader(doc);
    const excerpt = formatDocExcerpt(doc, maxSourceCap);
    if (!excerpt) {
      outcomes[index] = {
        note: `${header}\n- (No extractable page text returned.)`,
        usedFallback: true,
      };
    } else if (!doc.highlights?.length && doc.text.trim().length <= PASSTHROUGH_CHAR_LIMIT) {
      outcomes[index] = {
        note: `${header}\n${doc.text.trim()}`,
        usedFallback: false,
      };
    } else {
      pending.push({ index, doc, header, excerpt });
    }
  });

  if (pending.length > 0) {
    const chunkSize =
      opts.batchSize && opts.batchSize > 0
        ? Math.max(1, Math.floor(opts.batchSize))
        : pending.length;
    const isDeepBatch = opts.deep ?? Boolean(opts.batchSize && opts.batchSize <= 3);
    const cache = opts.cache ?? requestCache;
    const missedForRetry: typeof pending = [];

    const fallbackForItem = (
      item: (typeof pending)[number],
      inputText: string,
    ): CondenseSourceOutcome => ({
      note: `${item.header}\n${inputText.slice(0, FALLBACK_CHAR_CAP)}`,
      usedFallback: item.excerpt.length > FALLBACK_CHAR_CAP,
    });

    const condenseChunk = async (chunk: typeof pending): Promise<(string | null)[]> => {
      const summaryTokensFor = (modelId: string) =>
        fitSummaryOutputTokens(modelId, chunk.length, {
          deep: isDeepBatch,
          defaultMax: serverConfig.summary.batchMaxOutputTokens,
        });
      const perSourceCap = Math.min(
        maxSourceCap,
        Math.floor(BATCH_INPUT_CHAR_CAP / chunk.length),
      );
      const entries = chunk.map((p) => ({
        doc: p.doc,
        input: p.excerpt.slice(0, perSourceCap),
      }));

      const runBatchCall = async (batchSignal: AbortSignal): Promise<(string | null)[]> => {
        const promptForModel = (modelId: string) => {
          const modelBatchCap = maxSummaryBatchInputChars(
            modelId,
            BATCH_INPUT_CHAR_CAP,
          );
          const modelPerSourceCap = Math.min(
            maxSourceCap,
            Math.floor(modelBatchCap / chunk.length),
          );
          const sizedEntries =
            modelPerSourceCap < perSourceCap
              ? entries.map((e) => ({
                  doc: e.doc,
                  input: e.input.slice(0, modelPerSourceCap),
                }))
              : entries;
          return buildBatchPrompt(opts.query, sizedEntries, isDeepBatch);
        };
        const text = await generateAuxiliaryText({
          stage: opts.stage,
          system: SUMMARY_SYSTEM_PROMPT,
          prompt: promptForModel,
          maxOutputTokens: summaryTokensFor,
          timeoutMs: serverConfig.summary.timeoutMs,
          signal: batchSignal,
        });
        const notes = parseBatchNotes(text, entries.length);
        if (notes.every((n) => n === null)) {
          throw new Error("Summarizer returned no parseable source notes");
        }
        return notes;
      };

      return cache.wrap(
        "notes-batch",
        {
          sources: entries.map((e) => ({ url: e.doc.url, content: e.input })),
          q: normalizeCacheText(opts.query),
          ...(isDeepBatch ? { deep: true } : {}),
        },
        serverConfig.cache.notesTtlSeconds,
        runBatchCall,
        {
          bypass: opts.disableCache,
          requestId: opts.requestId,
          signal: opts.signal,
          shouldCache: (notes) => notes.every((n) => n !== null),
        },
      );
    };

    for (let offset = 0; offset < pending.length; offset += chunkSize) {
      const chunk = pending.slice(offset, offset + chunkSize);
      const perSourceCap = Math.min(
        maxSourceCap,
        Math.floor(BATCH_INPUT_CHAR_CAP / chunk.length),
      );
      try {
        const parsed = await condenseChunk(chunk);
        chunk.forEach((p, i) => {
          const rawNote = parsed[i];
          if (rawNote) {
            logDebug("summarize", {
              requestId: opts.requestId,
              url: p.doc.url,
              notesChars: rawNote.length,
            });
            outcomes[p.index] = { note: `${p.header}\n${rawNote}`, usedFallback: false };
          } else if (opts.retryMissing) {
            missedForRetry.push(p);
          } else {
            outcomes[p.index] = fallbackForItem(p, p.excerpt.slice(0, perSourceCap));
          }
        });
      } catch (error) {
        if (isAbortError(error) || opts.signal?.aborted) {
          throw createAbortError();
        }
        logError("summarize-batch", error, {
          requestId: opts.requestId,
          urls: chunk.map((p) => p.doc.url),
        });
        if (opts.retryMissing) {
          missedForRetry.push(...chunk);
        } else {
          chunk.forEach((p) => {
            outcomes[p.index] = fallbackForItem(p, p.excerpt.slice(0, perSourceCap));
          });
        }
      }
    }

    // Spend remaining time budget to condense any missed sources individually
    // through paced token leasing so partial-read fallbacks are eliminated.
    for (const item of missedForRetry) {
      const hasTimeBudget =
        opts.deadlineAt == null || opts.deadlineAt - Date.now() > 55_000;
      if (!hasTimeBudget) {
        outcomes[item.index] = fallbackForItem(item, item.excerpt);
        continue;
      }
      try {
        const [retriedNote] = await condenseChunk([item]);
        if (retriedNote) {
          logDebug("summarize-retry", {
            requestId: opts.requestId,
            url: item.doc.url,
            notesChars: retriedNote.length,
          });
          outcomes[item.index] = {
            note: `${item.header}\n${retriedNote}`,
            usedFallback: false,
          };
        } else {
          outcomes[item.index] = fallbackForItem(item, item.excerpt);
        }
      } catch (error) {
        if (isAbortError(error) || opts.signal?.aborted) {
          throw createAbortError();
        }
        logError("summarize-retry", error, {
          requestId: opts.requestId,
          url: item.doc.url,
        });
        outcomes[item.index] = fallbackForItem(item, item.excerpt);
      }
    }
  }

  const resolved = outcomes.map(
    (o, i): CondenseSourceOutcome =>
      o ?? {
        note: `${formatSourceHeader(docs[i])}\n- (No extractable page text returned.)`,
        usedFallback: true,
      },
  );

  return {
    notes: resolved.map((o) => o.note),
    fallbackCount: resolved.filter((o) => o.usedFallback).length,
  };
}
