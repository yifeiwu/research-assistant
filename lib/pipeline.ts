import "server-only";
import { isAbortError } from "./errors";
import { generateText } from "ai";
import type { ExaDocument } from "./exa";
import { selectRelevantExcerpt } from "./excerpt";
import { logDebug, logError } from "./logger";
import { serverConfig } from "./config";
import { groqReasoningOptions, maxSummaryOutputTokens } from "./models";
import { normalizeCacheText, requestCache, type RequestCache } from "./cache";
import { domainOf } from "./sources";
import { estimateTokens } from "./tokens";
import type { StageRunner } from "./agent/stage";

const PASSTHROUGH_CHAR_LIMIT = serverConfig.summary.passthroughCharLimit;
const BATCH_INPUT_CHAR_CAP = serverConfig.summary.batchInputCharCap;
const PER_SOURCE_INPUT_CHAR_CAP = serverConfig.summary.perSourceInputCharCap;
const FALLBACK_CHAR_CAP = serverConfig.summary.fallbackCharCap;

/**
 * Strip inline `<think>...</think>` blocks emitted by open-weight reasoning
 * models on OpenAI-compatible endpoints that don't separate reasoning fields.
 */
export function stripThinking(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<think>[\s\S]*$/gi, "")
    .trim();
}

function formatSourceHeader(doc: ExaDocument): string {
  return [
    `### ${doc.title ?? doc.url}`,
    `URL: ${doc.url}`,
    `Domain: ${domainOf(doc.url)} | Published: ${doc.publishedDate ?? "unlisted"}`,
  ].join("\n");
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
  /** Leases the summary model for the batched call (see lib/agent/stage.ts). */
  stage: StageRunner;
  query: string;
  signal?: AbortSignal;
  requestId?: string;
  cache?: RequestCache;
  disableCache?: boolean;
};

/**
 * Split a batched summarizer response into per-source notes. Sections are
 * headed `### Source N` (1-based, matching the order sources were sent);
 * a missing or empty section yields `null` so the caller can fall back to
 * a raw excerpt for just that source instead of failing the whole batch.
 */
export function parseBatchNotes(raw: string, count: number): (string | null)[] {
  const cleaned = stripThinking(raw);
  const sections = new Map<number, string>();
  const headingRe = /^### Source (\d+)[^\S\r\n]*$/gm;
  const matches = [...cleaned.matchAll(headingRe)];
  for (const [i, match] of matches.entries()) {
    const n = Number.parseInt(match[1], 10);
    if (!Number.isFinite(n) || n < 1 || n > count || sections.has(n)) continue;
    const start = (match.index ?? 0) + match[0].length;
    const end = i + 1 < matches.length ? (matches[i + 1].index ?? cleaned.length) : cleaned.length;
    const body = cleaned.slice(start, end).trim();
    if (body) sections.set(n, body);
  }
  return Array.from({ length: count }, (_, i) => sections.get(i + 1) ?? null);
}

function buildBatchPrompt(
  query: string,
  entries: { doc: ExaDocument; input: string }[],
): string {
  const blocks = entries.map(
    ({ doc, input }, i) =>
      `<source ${i + 1}>\nTitle: ${doc.title ?? doc.url}\nURL: ${doc.url}${doc.publishedDate ? `\nPublished: ${doc.publishedDate}` : ""}\nContent:\n"""\n${input}\n"""\n</source ${i + 1}>`,
  );
  return [
    `Research question:\n${query || "(not provided)"}`,
    "",
    `Condense EACH of the ${entries.length} sources below. For irrelevant sources output only "- Irrelevant to research question." so relevant sources get full detail (1 "- Profile: ... | Caveat: ..." bullet + up to 5 dense bullets with exact metrics, dates, conditions, and [Fact]/[Claim] tags).`,
    `Output exactly one section per source, in order, headed "### Source N" (N = the source number), with no introduction or conclusion.`,
    "",
    ...blocks,
  ].join("\n");
}

export type CondenseSourcesOutcome = { notes: string[]; fallbackCount: number };

/**
 * The "map" step for a round of documents. Short documents pass through
 * verbatim; the rest are condensed in ONE batched summary-model call for
 * the whole round instead of one call per source. That matters on Groq's
 * free tier, where the summary model allows only ~1k output tokens/min:
 * per-source calls at concurrency 4 spent most of their time failing on
 * 429/413 and retrying. The batch call is fail-fast (`maxRetries: 0`) —
 * on any provider error every pending source immediately falls back to a
 * raw excerpt (counted in `fallbackCount`, surfaced as degraded) rather
 * than burning seconds on retries that cannot succeed inside the window.
 */
export async function condenseSourcesDetailed(
  docs: ExaDocument[],
  opts: CondenseOpts,
): Promise<CondenseSourcesOutcome> {
  const outcomes: (CondenseSourceOutcome | undefined)[] = docs.map(() => undefined);
  const pending: { index: number; doc: ExaDocument; header: string; rawBody: string }[] = [];

  docs.forEach((doc, index) => {
    const header = formatSourceHeader(doc);
    const rawBody = doc.text.trim();
    if (!rawBody) {
      outcomes[index] = { note: `${header}\n- (No extractable page text returned.)`, usedFallback: true };
    } else if (rawBody.length <= PASSTHROUGH_CHAR_LIMIT) {
      outcomes[index] = { note: `${header}\n${rawBody}`, usedFallback: false };
    } else {
      pending.push({ index, doc, header, rawBody });
    }
  });

  if (pending.length > 0) {
    // Bounded slice per source so the whole batch fits the input cap.
    const perSourceCap = Math.min(
      PER_SOURCE_INPUT_CHAR_CAP,
      Math.floor(BATCH_INPUT_CHAR_CAP / pending.length),
    );
    const entries = pending.map((p) => ({
      doc: p.doc,
      input: selectRelevantExcerpt(p.rawBody, opts.query, perSourceCap),
    }));
    const fallbackFor = (i: number): CondenseSourceOutcome => ({
      note: `${pending[i].header}\n${entries[i].input.slice(0, FALLBACK_CHAR_CAP)}`,
      usedFallback: true,
    });

    const summaryTokensFor = (modelId: string) =>
      maxSummaryOutputTokens(modelId, serverConfig.summary.batchMaxOutputTokens);

    const cache = opts.cache ?? requestCache;
    try {
      const parsed = await cache.wrap(
        "notes-batch",
        {
          sources: entries.map((e) => ({ url: e.doc.url, content: e.input })),
          q: normalizeCacheText(opts.query),
          model: opts.stage.primaryModelId,
        },
        serverConfig.cache.notesTtlSeconds,
        async () => {
          const prompt = buildBatchPrompt(opts.query, entries);
          // Lease inside the loader so cache hits reserve nothing. The wait
          // (if any) happens here, before the model call, so it does not eat
          // into the call's timeout; a denied lease throws and every pending
          // source falls back to a raw excerpt below.
          const leased = await opts.stage.lease({
            estInputTokens: estimateTokens(SUMMARY_SYSTEM_PROMPT) + estimateTokens(prompt),
            maxOutputTokens: summaryTokensFor,
          });
          const { text } = await generateText({
            model: leased.model,
            system: SUMMARY_SYSTEM_PROMPT,
            maxOutputTokens: summaryTokensFor(leased.modelId),
            providerOptions: groqReasoningOptions(leased.modelId, "auxiliary"),
            // Signal-free loader (shared/coalesced via the cache); the
            // caller's own signal is passed to `wrap` below and only
            // detaches this caller.
            timeout: { totalMs: serverConfig.summary.timeoutMs },
            // Fail fast: a 429/413 from the summary model's tiny per-minute
            // budget will not clear on an immediate retry, so don't burn
            // seconds retrying — fall back to raw excerpts instead.
            maxRetries: 0,
            prompt,
          });
          const notes = parseBatchNotes(text, entries.length);
          if (notes.every((n) => n === null)) {
            throw new Error("Summarizer returned no parseable source notes");
          }
          return notes;
        },
        { bypass: opts.disableCache, requestId: opts.requestId, signal: opts.signal },
      );
      pending.forEach((p, i) => {
        const note = parsed[i];
        if (note) {
          logDebug("summarize", {
            requestId: opts.requestId,
            url: p.doc.url,
            rawChars: p.rawBody.length,
            notesChars: note.length,
          });
          outcomes[p.index] = { note: `${p.header}\n${note}`, usedFallback: false };
        } else {
          outcomes[p.index] = fallbackFor(i);
        }
      });
    } catch (error) {
      if (isAbortError(error) || opts.signal?.aborted) {
        throw new DOMException("The operation was aborted.", "AbortError");
      }
      logError("summarize-batch", error, {
        requestId: opts.requestId,
        urls: pending.map((p) => p.doc.url),
      });
      pending.forEach((p, i) => {
        outcomes[p.index] = fallbackFor(i);
      });
    }
  }

  const resolved = outcomes.map(
    (o, i): CondenseSourceOutcome =>
      o ?? { note: `${formatSourceHeader(docs[i])}\n- (No extractable page text returned.)`, usedFallback: true },
  );
  return {
    notes: resolved.map((o) => o.note),
    fallbackCount: resolved.filter((o) => o.usedFallback).length,
  };
}
