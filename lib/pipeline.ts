import "server-only";
import { isAbortError } from "./errors";
import { generateText, type LanguageModel } from "ai";
import type { ExaDocument } from "./exa";
import { logDebug, logError } from "./logger";
import { serverConfig } from "./config";
import { normalizeCacheText, requestCache, type RequestCache } from "./cache";

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
  const lines = [`### ${doc.title ?? doc.url}`, `URL: ${doc.url}`];
  if (doc.publishedDate) lines.push(`Published: ${doc.publishedDate}`);
  return lines.join("\n");
}


const SUMMARY_SYSTEM_PROMPT = `You compress raw web content into concise, factual research notes while critically evaluating the source.

Rules:
- Keep only information relevant to the research question.
- Preserve concrete facts: names, numbers, dates, quotes, and conclusions.
- Read the source skeptically. Distinguish verifiable facts from the source's own claims, opinions, or interpretations. Attribute claims to the source rather than stating them as established fact (e.g. "The article claims..." / "According to the author...").
- Flag signs of low reliability: missing evidence or citations, anonymous or unnamed sources, marketing/promotional or advertorial framing, opinion or editorial content, undisclosed conflicts of interest, emotionally loaded or one-sided language, vague or unfalsifiable assertions, outdated information, and claims that contradict well-established consensus.
- Note what the source does NOT substantiate: unsupported figures, cherry-picked data, or conclusions that outrun the evidence presented.
- If credibility signals are relevant, add a short "Reliability:" line noting the source type (e.g. peer-reviewed, news, blog, vendor page) and any caveats a reader should keep in mind.
- Use short bullet points. Keep critique factual and specific; do not editorialize beyond what the content supports.
- Output plain text bullet points only. Do not call tools or wrap output in JSON.
- If the content is not relevant to the question, say so in one line.
- You may receive several sources in one request. Condense each source separately under its own "### Source N" heading (N matching the source number given), in order, with no introduction or conclusion. Never merge facts across sources.`;

type CondenseSourceOutcome = { note: string; usedFallback: boolean };

export type CondenseOpts = {
  model: LanguageModel;
  query: string;
  signal?: AbortSignal;
  requestId?: string;
  modelId?: string;
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
      `<source ${i + 1}>\nTitle: ${doc.title ?? doc.url}\nURL: ${doc.url}\nContent:\n"""\n${input}\n"""\n</source ${i + 1}>`,
  );
  return [
    `Research question:\n${query || "(not provided)"}`,
    "",
    `Condense EACH of the ${entries.length} sources below into concise research notes (bullet points). Attribute claims to the source, distinguish fact from opinion, and flag any reliability concerns. Keep each source's notes very brief — at most 3 short bullets, prioritising concrete facts (names, numbers, dates) over commentary.`,
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
    const entries = pending.map((p) => ({ doc: p.doc, input: p.rawBody.slice(0, perSourceCap) }));
    const fallbackFor = (i: number): CondenseSourceOutcome => ({
      note: `${pending[i].header}\n${entries[i].input.slice(0, FALLBACK_CHAR_CAP)}`,
      usedFallback: true,
    });

    const cache = opts.cache ?? requestCache;
    try {
      const parsed = await cache.wrap(
        "notes-batch",
        {
          sources: entries.map((e) => ({ url: e.doc.url, content: e.input })),
          q: normalizeCacheText(opts.query),
          model: opts.modelId ?? "summary",
        },
        serverConfig.cache.notesTtlSeconds,
        async () => {
          const { text } = await generateText({
            model: opts.model,
            system: SUMMARY_SYSTEM_PROMPT,
            maxOutputTokens: serverConfig.summary.batchMaxOutputTokens,
            // Signal-free loader (shared/coalesced via the cache); the
            // caller's own signal is passed to `wrap` below and only
            // detaches this caller.
            timeout: { totalMs: serverConfig.summary.timeoutMs },
            // Fail fast: a 429/413 from the summary model's tiny per-minute
            // budget will not clear on an immediate retry, so don't burn
            // seconds retrying — fall back to raw excerpts instead.
            maxRetries: 0,
            prompt: buildBatchPrompt(opts.query, entries),
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
