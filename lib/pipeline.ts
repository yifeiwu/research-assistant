import "server-only";
import { createAbortError, isAbortError } from "./errors";
import type { ExaDocument } from "./exa";
import { selectRelevantExcerpt } from "./excerpt";
import { logDebug, logError } from "./logger";
import { serverConfig } from "./config";
import { maxSummaryOutputTokens } from "./models";
import { normalizeCacheText, requestCache, type RequestCache } from "./cache";
import { buildThematicReducePrompt } from "./prompts";
import { domainOf, extractUrls, normalizeUrlKey } from "./sources";
import { estimateTokens } from "./tokens";
import { generateAuxiliaryText, type StageRunner } from "./agent/stage";

const PASSTHROUGH_CHAR_LIMIT = serverConfig.summary.passthroughCharLimit;
const BATCH_INPUT_CHAR_CAP = serverConfig.summary.batchInputCharCap;
const PER_SOURCE_INPUT_CHAR_CAP = serverConfig.summary.perSourceInputCharCap;
const FALLBACK_CHAR_CAP = serverConfig.summary.fallbackCharCap;

export type PrimaryReferences = {
  urls: string[];
  queries: string[];
};

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
  /** Optional max sources per LLM batch (e.g. 2 on `high` effort for ~2x detail per source). */
  batchSize?: number;
  /** Optional per-source input excerpt cap (e.g. 4,500 chars on 2-source micro-batches). */
  perSourceCharCap?: number;
  /** Wait patiently for rolling Groq token windows in the scheduler. */
  patientWait?: boolean;
  /** Extract cited primary-source URLs and study/filing titles for cross-round citation hopping. */
  extractPrimaryRefs?: boolean;
  signal?: AbortSignal;
  requestId?: string;
  cache?: RequestCache;
  disableCache?: boolean;
};

export type ReduceNotesOpts = {
  stage: StageRunner;
  query: string;
  targetTokenBudget: number;
  patientWait?: boolean;
  signal?: AbortSignal;
  requestId?: string;
};

const PRIMARY_AUTHORITY_HOST_RE =
  /(?:^|\.)(?:arxiv\.org|doi\.org|openreview\.net|nature\.com|science\.org|nejm\.org|thelancet\.com|acm\.org|ieee\.org|sec\.gov|nber\.org|nih\.gov|fda\.gov|cdc\.gov|who\.int|europa\.eu)$|\.(?:gov|edu)(?:\.[a-z]{2})?$/i;

const NON_PRIMARY_SOCIAL_HOST_RE =
  /(?:^|\.)(?:twitter\.com|x\.com|facebook\.com|instagram\.com|linkedin\.com|youtube\.com|youtu\.be|tiktok\.com|reddit\.com|pinterest\.com)$/i;

const PRIMARY_REF_LINE_RE = /^\s*-\s*Primary-Ref\s*:\s*(.+)$/gim;

function isUsablePrimaryHopUrl(candidateUrl: string, selfKey: string): boolean {
  const key = normalizeUrlKey(candidateUrl);
  if (!key || key === selfKey) return false;
  try {
    const parsed = new URL(candidateUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    const host = parsed.hostname.replace(/^www\./i, "").toLowerCase();
    if (NON_PRIMARY_SOCIAL_HOST_RE.test(host)) return false;
    if (/\.(?:png|jpe?g|gif|webp|svg|ico|css|js|woff2?|mp4|mp3)$/i.test(parsed.pathname)) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Scan raw document text for links pointing directly to high-authority primary
 * artifacts (peer-reviewed venues, `.gov`/`.edu`, SEC/arXiv/DOI, or `.pdf` reports).
 */
function scanCitedPrimaryUrls(doc: ExaDocument, maxUrls = 3): string[] {
  const selfKey = normalizeUrlKey(doc.url);
  const selfHost = domainOf(doc.url).toLowerCase();
  const found: string[] = [];
  const seen = new Set<string>();

  for (const url of extractUrls(doc.text)) {
    if (found.length >= maxUrls) break;
    if (!isUsablePrimaryHopUrl(url, selfKey)) continue;
    const key = normalizeUrlKey(url);
    if (seen.has(key)) continue;
    try {
      const parsed = new URL(url);
      const host = parsed.hostname.replace(/^www\./i, "").toLowerCase();
      const isPdf = /\.pdf$/i.test(parsed.pathname);
      const isAuthority = PRIMARY_AUTHORITY_HOST_RE.test(host);
      if (!isAuthority && !(isPdf && host !== selfHost)) continue;
      seen.add(key);
      found.push(url);
    } catch {
      continue;
    }
  }
  return found;
}

/**
 * Strip `- Primary-Ref: ...` metadata lines from a condensed note (so unretrieved
 * URLs never leak into synthesis) and return any cited URLs or study titles.
 */
function extractAndStripPrimaryRefs(
  noteBody: string,
  selfUrl: string,
): { cleanedBody: string; urls: string[]; queries: string[] } {
  const selfKey = normalizeUrlKey(selfUrl);
  const urls: string[] = [];
  const queries: string[] = [];

  const cleanedBody = noteBody
    .replace(PRIMARY_REF_LINE_RE, (_full, rawVal: string) => {
      const val = rawVal.trim().replace(/^["'`]+|["'`]+$/g, "").trim();
      if (!val || /^(?:none|n\/a|null|not applicable|unknown)\.?$/i.test(val)) {
        return "";
      }
      const lineUrls = extractUrls(val);
      if (lineUrls.length > 0) {
        for (const u of lineUrls) {
          if (isUsablePrimaryHopUrl(u, selfKey)) {
            urls.push(u);
          }
        }
      } else if (val.length >= 8 && val.length <= 180) {
        queries.push(val);
      }
      return "";
    })
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { cleanedBody, urls, queries };
}

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
  opts?: { deep?: boolean; extractPrimaryRefs?: boolean },
): string {
  const blocks = entries.map(
    ({ doc, input }, i) =>
      `<source ${i + 1}>\nTitle: ${doc.title ?? doc.url}\nURL: ${doc.url}${doc.publishedDate ? `\nPublished: ${doc.publishedDate}` : ""}\nContent:\n"""\n${input}\n"""\n</source ${i + 1}>`,
  );
  const bulletAllowance = opts?.deep ? 7 : 5;
  const primaryRefInstruction = opts?.extractPrimaryRefs
    ? ` If a secondary article cites a specific underlying primary study, regulatory filing, or benchmark not at its own URL, append one final bullet "- Primary-Ref: <exact https:// URL if present in text, otherwise exact study/filing/report title>".`
    : "";
  return [
    `Research question:\n${query || "(not provided)"}`,
    "",
    `Condense EACH of the ${entries.length} sources below. For irrelevant sources output only "- Irrelevant to research question." so relevant sources get full detail (1 "- Profile: ... | Caveat: ..." bullet + up to ${bulletAllowance} dense bullets with exact metrics, dates, conditions, and [Fact]/[Claim] tags).${primaryRefInstruction}`,
    `Output exactly one section per source, in order, headed "### Source N" (N = the source number), with no introduction or conclusion.`,
    "",
    ...blocks,
  ].join("\n");
}

export type CondenseSourcesOutcome = {
  notes: string[];
  fallbackCount: number;
  primaryRefs?: PrimaryReferences;
};

/**
 * The "map" step for a round of documents. Short documents pass through
 * verbatim; the rest are condensed in batched summary-model calls (a single
 * round-wide batch on `medium` effort, or 2-source micro-batches with patient
 * token-bucket waiting on `high` effort for ~2x factual detail per source).
 */
export async function condenseSourcesDetailed(
  docs: ExaDocument[],
  opts: CondenseOpts,
): Promise<CondenseSourcesOutcome> {
  const outcomes: (CondenseSourceOutcome | undefined)[] = docs.map(() => undefined);
  const pending: { index: number; doc: ExaDocument; header: string; rawBody: string }[] = [];

  const hoppedUrlMap = new Map<string, string>();
  const hoppedQueryMap = new Map<string, string>();
  const recordHopUrl = (url: string) => {
    const key = normalizeUrlKey(url);
    if (key && !hoppedUrlMap.has(key)) hoppedUrlMap.set(key, url);
  };
  const recordHopQuery = (q: string) => {
    const norm = q.toLowerCase().replace(/\s+/g, " ").trim();
    if (norm && !hoppedQueryMap.has(norm)) hoppedQueryMap.set(norm, q.trim());
  };

  docs.forEach((doc, index) => {
    if (opts.extractPrimaryRefs && doc.text.trim()) {
      for (const u of scanCitedPrimaryUrls(doc)) recordHopUrl(u);
    }
    const header = formatSourceHeader(doc);
    const rawBody = doc.text.trim();
    if (!rawBody) {
      outcomes[index] = { note: `${header}\n- (No extractable page text returned.)`, usedFallback: true };
    } else if (rawBody.length <= PASSTHROUGH_CHAR_LIMIT) {
      const passthroughBody = doc.highlights?.length
        ? selectRelevantExcerpt(rawBody, opts.query, PASSTHROUGH_CHAR_LIMIT + 600, doc.highlights)
        : rawBody;
      outcomes[index] = { note: `${header}\n${passthroughBody}`, usedFallback: false };
    } else {
      pending.push({ index, doc, header, rawBody });
    }
  });

  if (pending.length > 0) {
    const chunkSize =
      opts.batchSize && opts.batchSize > 0
        ? Math.max(1, Math.floor(opts.batchSize))
        : pending.length;
    const isDeepMicroBatch = Boolean(opts.batchSize && opts.batchSize <= 2);
    const maxSourceCap = opts.perSourceCharCap ?? PER_SOURCE_INPUT_CHAR_CAP;
    const leaseWaitMs = opts.patientWait
      ? serverConfig.groqRateLimit.deepBudgetWait.summaryMs
      : undefined;

    const summaryTokensFor = (modelId: string) =>
      maxSummaryOutputTokens(modelId, serverConfig.summary.batchMaxOutputTokens);

    const cache = opts.cache ?? requestCache;

    for (let offset = 0; offset < pending.length; offset += chunkSize) {
      const chunk = pending.slice(offset, offset + chunkSize);
      const perSourceCap = Math.min(
        maxSourceCap,
        Math.floor(BATCH_INPUT_CHAR_CAP / chunk.length),
      );
      const entries = chunk.map((p) => ({
        doc: p.doc,
        input: selectRelevantExcerpt(
          p.rawBody,
          opts.query,
          perSourceCap,
          p.doc.highlights,
        ),
      }));
      const fallbackFor = (i: number): CondenseSourceOutcome => ({
        note: `${chunk[i].header}\n${entries[i].input.slice(0, FALLBACK_CHAR_CAP)}`,
        usedFallback: true,
      });

      const runBatchCall = async (): Promise<(string | null)[]> => {
        const prompt = buildBatchPrompt(opts.query, entries, {
          deep: isDeepMicroBatch,
          extractPrimaryRefs: opts.extractPrimaryRefs,
        });
        const text = await generateAuxiliaryText({
          stage: opts.stage,
          system: SUMMARY_SYSTEM_PROMPT,
          prompt,
          maxOutputTokens: summaryTokensFor,
          timeoutMs: serverConfig.summary.timeoutMs,
          maxWaitMs: leaseWaitMs,
        });
        const notes = parseBatchNotes(text, entries.length);
        if (notes.every((n) => n === null)) {
          throw new Error("Summarizer returned no parseable source notes");
        }
        return notes;
      };

      try {
        const parsed = await cache.wrap(
          "notes-batch",
          {
            sources: entries.map((e) => ({ url: e.doc.url, content: e.input })),
            q: normalizeCacheText(opts.query),
            model: opts.stage.primaryModelId,
            ...(isDeepMicroBatch ? { deep: true } : {}),
            ...(opts.extractPrimaryRefs ? { refs: true } : {}),
          },
          serverConfig.cache.notesTtlSeconds,
          runBatchCall,
          { bypass: opts.disableCache, requestId: opts.requestId, signal: opts.signal },
        );
        chunk.forEach((p, i) => {
          const rawNote = parsed[i];
          if (rawNote) {
            let finalNote = rawNote;
            if (opts.extractPrimaryRefs) {
              const extracted = extractAndStripPrimaryRefs(rawNote, p.doc.url);
              finalNote = extracted.cleanedBody || rawNote;
              for (const u of extracted.urls) recordHopUrl(u);
              for (const q of extracted.queries) recordHopQuery(q);
            }
            logDebug("summarize", {
              requestId: opts.requestId,
              url: p.doc.url,
              rawChars: p.rawBody.length,
              notesChars: finalNote.length,
            });
            outcomes[p.index] = { note: `${p.header}\n${finalNote}`, usedFallback: false };
          } else {
            outcomes[p.index] = fallbackFor(i);
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
        chunk.forEach((p, i) => {
          outcomes[p.index] = fallbackFor(i);
        });
      }
    }
  }

  const resolved = outcomes.map(
    (o, i): CondenseSourceOutcome =>
      o ?? { note: `${formatSourceHeader(docs[i])}\n- (No extractable page text returned.)`, usedFallback: true },
  );
  const primaryRefs: PrimaryReferences | undefined = opts.extractPrimaryRefs
    ? {
        urls: [...hoppedUrlMap.values()],
        queries: [...hoppedQueryMap.values()],
      }
    : undefined;

  return {
    notes: resolved.map((o) => o.note),
    fallbackCount: resolved.filter((o) => o.usedFallback).length,
    ...(primaryRefs ? { primaryRefs } : {}),
  };
}

/**
 * Partition labeled notes into balanced clusters under `clusterTokenCap` so each
 * cluster fits comfortably inside a single model call's input window.
 */
function partitionNoteClusters(
  labeledNotes: string[],
  clusterTokenCap: number = serverConfig.reduce.clusterTokenCap,
): string[][] {
  if (labeledNotes.length === 0) return [];
  const clusters: string[][] = [];
  let current: string[] = [];
  let currentTokens = 0;

  for (const note of labeledNotes) {
    const noteTokens = estimateTokens(note);
    if (current.length > 0 && currentTokens + noteTokens > clusterTokenCap) {
      clusters.push(current);
      current = [note];
      currentTokens = noteTokens;
    } else {
      current.push(note);
      currentTokens += noteTokens;
    }
  }
  if (current.length > 0) clusters.push(current);
  return clusters;
}

/**
 * Hierarchical "Thematic Reduce" pass for deep multi-round research: when
 * gathered notes exceed `targetTokenBudget`, distills clusters into
 * citation-preserved analytical sub-briefs instead of truncating source notes.
 */
export async function reduceNotesDetailed(
  notes: string[],
  opts: ReduceNotesOpts,
): Promise<{ evidenceBlock: string; reduced: boolean }> {
  if (notes.length === 0) return { evidenceBlock: "", reduced: false };

  const labeledAll = notes.map((n, idx) => ({
    formatted: `[Source ${idx + 1}]\n${n}`,
    irrelevant: isIrrelevantNote(n),
  }));
  const relevant = labeledAll.filter((it) => !it.irrelevant);
  const active = (relevant.length > 0 ? relevant : labeledAll).map((it) => it.formatted);

  const joined = active.join("\n\n---\n\n");
  if (estimateTokens(joined) <= opts.targetTokenBudget) {
    return { evidenceBlock: joined, reduced: false };
  }

  const clusters = partitionNoteClusters(active, serverConfig.reduce.clusterTokenCap);
  const system = buildThematicReducePrompt();
  const perClusterDesiredTokens = Math.min(
    serverConfig.reduce.maxOutputTokens,
    Math.max(350, Math.floor((opts.targetTokenBudget * 0.92) / clusters.length)),
  );
  const outputTokensFor = (modelId: string) =>
    maxSummaryOutputTokens(modelId, perClusterDesiredTokens);
  const leaseWaitMs = opts.patientWait
    ? serverConfig.groqRateLimit.deepBudgetWait.summaryMs
    : undefined;

  const distilledParts: string[] = [];
  let anyReduced = false;

  for (let i = 0; i < clusters.length; i++) {
    if (opts.signal?.aborted) {
      throw createAbortError();
    }
    const clusterBlock = clusters[i].join("\n\n---\n\n");
    const prompt = [
      `Research question:\n${opts.query}`,
      "",
      `Distill the following research notes (Cluster ${i + 1} of ${clusters.length}) into a high-density, lossless analytical sub-brief preserving EVERY relevant metric, date, condition, [Fact]/[Claim] tag, source rigor profile, and exact [Source Title](URL) link:`,
      "",
      clusterBlock,
    ].join("\n");

    try {
      const text = await generateAuxiliaryText({
        stage: opts.stage,
        system,
        prompt,
        maxOutputTokens: outputTokensFor,
        timeoutMs: serverConfig.reduce.timeoutMs,
        maxWaitMs: leaseWaitMs,
        signal: opts.signal,
      });
      const cleaned = stripThinking(text);
      if (cleaned.length >= 40) {
        distilledParts.push(cleaned);
        anyReduced = true;
      } else {
        distilledParts.push(clusterBlock);
      }
    } catch (error) {
      if (isAbortError(error) || opts.signal?.aborted) {
        throw createAbortError();
      }
      logError("thematic-reduce", error, {
        requestId: opts.requestId,
        cluster: i + 1,
        clusters: clusters.length,
      });
      distilledParts.push(clusterBlock);
    }
  }

  return {
    evidenceBlock: distilledParts.join("\n\n---\n\n"),
    reduced: anyReduced,
  };
}
