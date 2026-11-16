import "server-only";
import { isAbortError } from "./errors";
import type {
  ModelMessage,
  UIMessageStreamWriter,
} from "ai";
import type { EffortConfig, EffortLevel } from "./effort";
import {
  createExaClient,
  type ExaDocument,
  type ExaSearchOutcome,
  type ExaSearchRequestOptions,
} from "./exa";
import { tokenizeQuery } from "./excerpt";
import { logDebug, logError, logInfo } from "./logger";
import {
  condenseSourcesDetailed,
  isIrrelevantNote,
  reduceNotesDetailed,
  stripThinking,
  type CondenseSourcesOutcome,
} from "./pipeline";
import {
  buildGapCheckPrompt,
  buildQueryPlanPrompt,
  buildRerankPrompt,
} from "./prompts";
import { domainOf, extractUrls, normalizeUrlKey } from "./sources";
import { serverConfig } from "./config";
import { estimateTokens } from "./tokens";
import { generateAuxiliaryText, type StageRunner } from "./agent/stage";
import type {
  ChatUIMessage,
  DegradedResearch,
  ResearchSource,
  ResearchStepData,
} from "./types/chat";

type StepContext = { signal?: AbortSignal; requestId?: string };

export interface Planner {
  planQuery(
    input: { messages: ModelMessage[]; effortLevel?: EffortLevel } & StepContext,
  ): Promise<{ stopped: boolean; brief?: string; query?: string }>;
  planFollowUp(
    input: {
      query: string;
      priorQueries: string[];
      notes: string;
      effortLevel?: EffortLevel;
      citedPrimaryQueries?: string[];
    } & StepContext,
  ): Promise<{ stopped: boolean; query?: string }>;
  rerankSources?(
    input: { query: string; candidates: ExaDocument[]; maxSelect: number } & StepContext,
  ): Promise<ExaDocument[]>;
}

export interface SearchProvider {
  search(
    query: string,
    numResults: number,
    ctx: StepContext & ExaSearchRequestOptions,
  ): Promise<ExaSearchOutcome>;
  fetchContents(
    urls: string[],
    ctx: StepContext & { maxCharacters?: number },
  ): Promise<ExaSearchOutcome>;
}

export interface Condenser {
  condense(
    docs: ExaDocument[],
    input: {
      query: string;
      batchSize?: number;
      perSourceCharCap?: number;
      patientWait?: boolean;
      extractPrimaryRefs?: boolean;
    } & StepContext,
  ): Promise<CondenseSourcesOutcome>;
  reduceNotes?(
    notes: string[],
    input: { query: string; targetTokenBudget: number; patientWait?: boolean } & StepContext,
  ): Promise<{ evidenceBlock: string; reduced: boolean }>;
}

export type ResearchDeps = {
  planner: Planner;
  search: SearchProvider;
  condenser: Condenser;
};

const MAX_EXPLICIT_URLS = 4;
const MAX_HOP_URLS_PER_ROUND = 2;
const MAX_QUERY_LENGTH = 240;
const MAX_BRIEF_LENGTH = 360;

/**
 * Where a turn's research time went: wall time per stage in ms, summed over
 * its rounds. Each figure includes any wait for a model's rate-limit window
 * or an Exa slot, since that is time the user waited too.
 */
export type ResearchStats = {
  /** Rounds that searched. */
  rounds: number;
  planMs: number;
  searchMs: number;
  readMs: number;
  gapCheckMs: number;
};

export type ResearchOutcome = {
  /** Absent when no research was attempted (and on older checkpoints). */
  stats?: ResearchStats;
  searched: boolean;
  /** True when search was attempted but no sources could be retrieved at all. */
  searchFailed?: boolean;
  evidenceBlock: string;
  totalSources: number;
  sources: ResearchSource[];
  degraded?: DegradedResearch;
};

/**
 * Parse a single plain-text search query (or stop token) from model output,
 * tolerating inline `<think>` blocks, bullets, numbering, quotes, preamble
 * lines, and skipping any queries already present in `exclude`.
 */
export function parsePlainTextQuery(
  raw: string,
  opts: { stopToken: string; exclude?: Iterable<string> },
): { stopped: boolean; query?: string } {
  const cleaned = stripThinking(raw);
  if (!cleaned) return { stopped: false };

  const rawLines = cleaned
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (
    rawLines.length === 1 &&
    new RegExp(`^[\`"']*${opts.stopToken}[\`"'.!]*$`, "i").test(rawLines[0])
  ) {
    return { stopped: true };
  }

  const excluded = new Set<string>();
  if (opts.exclude) {
    for (const item of opts.exclude) {
      excluded.add(item.toLowerCase().trim());
    }
  }

  for (const rawLine of rawLines) {
    if (rawLine.startsWith("```")) continue;
    if (/^(here (?:is|are)|search quer(?:y|ies)|follow-up quer(?:y|ies)|quer(?:y|ies))\b.*:$/i.test(rawLine)) {
      continue;
    }
    const normalized = rawLine
      .replace(/^(?:[-*•]+|\d+[.)])\s*/, "")
      .replace(/^["'`]+|["'`]+$/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!normalized) continue;
    if (new RegExp(`^${opts.stopToken}[.!]*$`, "i").test(normalized)) {
      return { stopped: true };
    }
    if (normalized.length < 2) continue;
    const clipped = normalized.slice(0, MAX_QUERY_LENGTH);
    if (excluded.has(clipped.toLowerCase())) continue;
    return { stopped: false, query: clipped };
  }
  return { stopped: false };
}

/**
 * Parse Stage 1 query-planner output containing an optional `BRIEF: ...` line
 * followed by a single initial search query, or `NO_SEARCH`.
 */
export function parseQueryPlan(raw: string): {
  stopped: boolean;
  brief?: string;
  query?: string;
} {
  const cleaned = stripThinking(raw);
  if (!cleaned) return { stopped: false };

  const rawLines = cleaned
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (
    rawLines.length === 1 &&
    /^[\`"']*NO_SEARCH[\`"'.!]*$/i.test(rawLines[0])
  ) {
    return { stopped: true };
  }

  let brief: string | undefined;
  const remainingLines: string[] = [];
  for (const line of rawLines) {
    const briefMatch = line.match(/^(?:[-*•]\s*)?[`"']*BRIEF[`"']*\s*:\s*(.+)$/i);
    if (briefMatch && !brief) {
      const candidate = briefMatch[1]
        .replace(/^["'`]+|["'`]+$/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, MAX_BRIEF_LENGTH);
      if (candidate && !/^NO_SEARCH[.!]*$/i.test(candidate)) {
        brief = candidate;
        continue;
      }
      if (/^NO_SEARCH[.!]*$/i.test(candidate)) {
        return { stopped: true };
      }
    }
    remainingLines.push(line);
  }

  const parsed = parsePlainTextQuery(remainingLines.join("\n"), {
    stopToken: "NO_SEARCH",
  });
  if (parsed.stopped && !brief) {
    return { stopped: true };
  }
  return {
    stopped: false,
    ...(brief ? { brief } : {}),
    ...(parsed.query ? { query: parsed.query } : {}),
  };
}

const MULTI_PART_TLDS = new Set([
  "co.uk", "org.uk", "gov.uk", "ac.uk",
  "com.au", "org.au", "gov.au", "edu.au",
  "co.jp", "co.nz", "co.in", "com.br", "com.sg",
]);

function registrableDomain(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
    const parts = host.split(".").filter(Boolean);
    if (parts.length <= 2) return host;
    const lastTwo = `${parts[parts.length - 2]}.${parts[parts.length - 1]}`;
    if (MULTI_PART_TLDS.has(lastTwo) && parts.length >= 3) {
      return `${parts[parts.length - 3]}.${lastTwo}`;
    }
    return lastTwo;
  } catch {
    return url.toLowerCase();
  }
}

function rankBatchCandidates(docs: ExaDocument[], query?: string): ExaDocument[] {
  const nonEmpty = docs.filter((d) => d.text.trim().length > 0);
  if (!query || !query.trim() || nonEmpty.length <= 1) return nonEmpty;

  const terms = tokenizeQuery(query);
  const freshnessSensitive = /\b(latest|recent|current|today|new|update|updated|202[4-9])\b/i.test(query);
  const nowMs = Date.now();

  const scored = nonEmpty.map((doc, idx) => {
    let score = Math.max(0, 1 - idx * 0.14);

    if (terms.length > 0) {
      const titleLower = (doc.title ?? "").toLowerCase();
      const bodyLower = doc.text.slice(0, 6_000).toLowerCase();
      let titleHits = 0;
      let bodyHits = 0;
      for (const term of terms) {
        if (titleLower.includes(term)) titleHits += 1;
        if (bodyLower.includes(term)) bodyHits += 1;
      }
      score += (titleHits / terms.length) * 0.65 + (bodyHits / terms.length) * 0.65;
    }

    if (/\b\d+(?:\.\d+)?%|\$\d|\b(?:19|20)\d{2}\b/.test(doc.text.slice(0, 6_000))) {
      score += 0.2;
    }

    if (freshnessSensitive && doc.publishedDate) {
      const pubMs = Date.parse(doc.publishedDate);
      if (Number.isFinite(pubMs) && pubMs <= nowMs + 86_400_000) {
        const ageDays = Math.max(0, (nowMs - pubMs) / 86_400_000);
        if (ageDays <= 540) {
          score += 0.35 * (1 - ageDays / 540);
        }
      }
    }

    return { doc, idx, score };
  });

  scored.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.idx - b.idx));
  return scored.map((s) => s.doc);
}

export type SelectDocsOptions = {
  query?: string;
  maxPerDomain?: number;
  minSubstantiveChars?: number;
};

/**
 * Select up to `maxCount` unique documents from a round's search results while
 * deduplicating against `seenUrlKeys`, dropping empty pages, and preferring
 * substantive, domain-diverse sources before backfilling remaining slots.
 */
export function selectDeduplicatedDocs(
  priorityDocs: ExaDocument[],
  searchDocs: ExaDocument[],
  seenUrlKeys: Set<string>,
  maxCount: number,
  opts?: SelectDocsOptions,
): ExaDocument[] {
  if (maxCount <= 0) return [];
  const maxPerDomain = opts?.maxPerDomain ?? 2;
  const minSubstantiveChars = opts?.minSubstantiveChars ?? 200;

  const selected: ExaDocument[] = [];
  const domainCounts = new Map<string, number>();

  const recordDoc = (doc: ExaDocument, key: string, domain: string) => {
    seenUrlKeys.add(key);
    domainCounts.set(domain, (domainCounts.get(domain) ?? 0) + 1);
    selected.push(doc);
  };

  for (const doc of priorityDocs) {
    if (selected.length >= maxCount) break;
    const key = normalizeUrlKey(doc.url);
    if (!key || seenUrlKeys.has(key)) continue;
    recordDoc(doc, key, registrableDomain(doc.url));
  }

  const ranked = rankBatchCandidates(searchDocs, opts?.query);

  for (const doc of ranked) {
    if (selected.length >= maxCount) break;
    if (doc.text.trim().length < minSubstantiveChars) continue;
    const key = normalizeUrlKey(doc.url);
    if (!key || seenUrlKeys.has(key)) continue;
    const domain = registrableDomain(doc.url);
    if ((domainCounts.get(domain) ?? 0) >= maxPerDomain) continue;
    recordDoc(doc, key, domain);
  }

  if (selected.length < maxCount) {
    for (const doc of ranked) {
      if (selected.length >= maxCount) break;
      const key = normalizeUrlKey(doc.url);
      if (!key || seenUrlKeys.has(key)) continue;
      recordDoc(doc, key, registrableDomain(doc.url));
    }
  }

  return selected;
}

/**
 * Water-filling fair-share token budgeter across research notes.
 */
export function budgetNotesFairly(
  notes: string[],
  tokenBudget: number,
  opts?: {
    separator?: string;
    labelSources?: boolean;
    trimMarker?: string;
  },
): { text: string; trimmedCount: number } {
  if (notes.length === 0 || tokenBudget <= 0) {
    return { text: "", trimmedCount: notes.length };
  }

  const sep = opts?.separator ?? "\n\n";
  const charBudget = Math.max(0, tokenBudget) * 4;
  const items = notes.map((note, idx) => ({
    idx,
    formatted: opts?.labelSources ? `[Source ${idx + 1}]\n${note}` : note,
    irrelevant: isIrrelevantNote(note),
  }));

  const fullJoined = items.map((it) => it.formatted).join(sep);
  if (fullJoined.length <= charBudget) {
    return { text: fullJoined, trimmedCount: 0 };
  }

  let active = items;
  let droppedCount = 0;
  const relevantItems = items.filter((it) => !it.irrelevant);
  if (relevantItems.length > 0 && relevantItems.length < items.length) {
    droppedCount = items.length - relevantItems.length;
    active = relevantItems;
    const relevantJoined = active.map((it) => it.formatted).join(sep);
    if (relevantJoined.length <= charBudget) {
      return { text: relevantJoined, trimmedCount: droppedCount };
    }
  }

  const sepTotal = Math.max(0, active.length - 1) * sep.length;
  let remainingPool = Math.max(0, charBudget - sepTotal);
  const allocations = new Array<number>(active.length).fill(0);
  const unlocked = new Set<number>(active.map((_, i) => i));

  while (unlocked.size > 0) {
    const share = Math.floor(remainingPool / unlocked.size);
    const fitsNow: number[] = [];
    for (const i of unlocked) {
      if (active[i].formatted.length <= share) {
        fitsNow.push(i);
      }
    }
    if (fitsNow.length === 0) break;
    for (const i of fitsNow) {
      allocations[i] = active[i].formatted.length;
      remainingPool -= allocations[i];
      unlocked.delete(i);
    }
  }

  if (unlocked.size > 0) {
    const baseShare = Math.floor(remainingPool / unlocked.size);
    let remainder = remainingPool - baseShare * unlocked.size;
    for (const i of unlocked) {
      allocations[i] = baseShare + (remainder > 0 ? 1 : 0);
      if (remainder > 0) remainder -= 1;
    }
  }

  let truncatedCount = 0;
  const parts: string[] = [];
  for (let i = 0; i < active.length; i++) {
    const full = active[i].formatted;
    const cap = allocations[i];
    if (full.length <= cap) {
      parts.push(full);
    } else {
      truncatedCount += 1;
      const sliced = full.slice(0, cap);
      parts.push(opts?.trimMarker ? `${sliced}\n${opts.trimMarker}` : sliced);
    }
  }

  return {
    text: parts.join(sep),
    trimmedCount: droppedCount + truncatedCount,
  };
}

/**
 * Parse 1-based candidate indices emitted by the source reranker, deduplicating
 * and backfilling any remaining slots in deterministic rank order.
 */
export function parseRerankIndices(
  raw: string,
  candidateCount: number,
  maxSelect: number,
): number[] {
  const cap = Math.min(candidateCount, Math.max(0, maxSelect));
  if (cap === 0) return [];
  const cleaned = stripThinking(raw);
  const picked: number[] = [];
  const seen = new Set<number>();

  for (const match of cleaned.matchAll(/\b(\d+)\b/g)) {
    const oneBased = Number.parseInt(match[1], 10);
    if (!Number.isFinite(oneBased) || oneBased < 1 || oneBased > candidateCount) {
      continue;
    }
    const idx = oneBased - 1;
    if (seen.has(idx)) continue;
    seen.add(idx);
    picked.push(idx);
    if (picked.length >= cap) return picked;
  }

  for (let i = 0; i < candidateCount && picked.length < cap; i++) {
    if (!seen.has(i)) {
      seen.add(i);
      picked.push(i);
    }
  }
  return picked;
}

function toResearchSource(doc: ExaDocument): ResearchSource {
  return { url: doc.url, title: doc.title, publishedDate: doc.publishedDate };
}

function createTextPlanner(
  stage: StageRunner,
  opts?: { patientWait?: boolean },
): Planner {
  const maxWaitMs = opts?.patientWait
    ? serverConfig.groqRateLimit.deepBudgetWait.plannerMs
    : undefined;

  return {
    async planQuery({ messages, effortLevel, signal }) {
      const text = await generateAuxiliaryText({
        stage,
        system: buildQueryPlanPrompt(effortLevel),
        messages,
        maxOutputTokens: serverConfig.planner.maxOutputTokens,
        timeoutMs: serverConfig.planner.timeoutMs,
        maxWaitMs,
        signal,
      });
      return parseQueryPlan(text);
    },
    async planFollowUp({
      query,
      priorQueries,
      notes,
      effortLevel,
      citedPrimaryQueries,
      signal,
    }) {
      const citedSection =
        citedPrimaryQueries && citedPrimaryQueries.length > 0
          ? `Primary sources cited in articles (not yet retrieved directly):\n${citedPrimaryQueries.map((c) => `- ${c}`).join("\n")}\n\n`
          : "";
      const prompt = `User question:\n${query}\n\nQueries already run:\n${priorQueries.map((q) => `- ${q}`).join("\n")}\n\n${citedSection}Gathered research notes so far:\n${notes}\n\nDecide whether these notes are sufficient ("DONE") or output ONE targeted follow-up search query.`;
      const text = await generateAuxiliaryText({
        stage,
        system: buildGapCheckPrompt(effortLevel),
        prompt,
        maxOutputTokens: serverConfig.gapCheck.maxOutputTokens,
        timeoutMs: serverConfig.gapCheck.timeoutMs,
        maxWaitMs,
        signal,
      });
      return parsePlainTextQuery(text, {
        stopToken: "DONE",
        exclude: priorQueries,
      });
    },
    async rerankSources({ query, candidates, maxSelect, signal }) {
      if (candidates.length <= maxSelect) return candidates.slice(0, maxSelect);
      const items = candidates.map((doc, i) => {
        const rawSnippet = doc.highlights?.[0] ?? doc.text.slice(0, 260);
        const snippet = rawSnippet.replace(/\s+/g, " ").trim().slice(0, 220);
        return `[${i + 1}] ${doc.title ?? doc.url} (${domainOf(doc.url)}${doc.publishedDate ? `, ${doc.publishedDate.slice(0, 10)}` : ""})\nSnippet: ${snippet}`;
      });
      const prompt = `Research question:\n${query}\n\nCandidates:\n${items.join("\n\n")}\n\nSelect the best ${maxSelect} candidate numbers:`;
      const text = await generateAuxiliaryText({
        stage,
        system: buildRerankPrompt(maxSelect),
        prompt,
        maxOutputTokens: serverConfig.rerank.maxOutputTokens,
        timeoutMs: serverConfig.rerank.timeoutMs,
        maxWaitMs,
        signal,
      });
      const indices = parseRerankIndices(text, candidates.length, maxSelect);
      return indices.map((idx) => candidates[idx]);
    },
  };
}

/**
 * Execute the deterministic multi-stage research pipeline, emitting live
 * `data-research-step` and `source-url` UI stream chunks along the way.
 */
export async function runResearchPipeline(opts: {
  messages: ModelMessage[];
  query: string;
  effort: EffortConfig;
  stages: { planner: StageRunner; summary: StageRunner };
  writer: UIMessageStreamWriter<ChatUIMessage>;
  signal?: AbortSignal;
  requestId: string;
  deps?: Partial<ResearchDeps>;
}): Promise<ResearchOutcome> {
  const { messages, query, effort, writer, signal, requestId } = opts;
  const {
    resultsPerQuery,
    deepResultsPerQuery,
    sourcesPerRound,
    maxSources,
    deepGatherTokenBudget,
  } = serverConfig.research;

  if (effort.rounds === 0 || !query.trim()) {
    return { searched: false, evidenceBlock: "", totalSources: 0, sources: [] };
  }

  const isDeep = effort.deep;
  const planner =
    opts.deps?.planner ??
    createTextPlanner(opts.stages.planner, { patientWait: isDeep });
  const search: SearchProvider =
    opts.deps?.search ??
    (() => {
      const exa = createExaClient({ signal, requestId });
      return {
        search: exa.searchDetailed,
        fetchContents: exa.fetchDetailed,
      };
    })();
  const condenser: Condenser = opts.deps?.condenser ?? {
    condense: (docs, input) =>
      condenseSourcesDetailed(docs, { stage: opts.stages.summary, ...input }),
    reduceNotes: (notes, input) =>
      reduceNotesDetailed(notes, { stage: opts.stages.summary, ...input }),
  };

  const roundResultsPerQuery = isDeep ? deepResultsPerQuery : resultsPerQuery;
  const docMaxChars = isDeep ? serverConfig.exa.deepMaxChars : undefined;
  const evidenceBudget = isDeep
    ? serverConfig.blueprint.deepEvidenceTokenBudget
    : serverConfig.synthesis.evidenceTokenBudget;
  const gatherBudget = isDeep ? deepGatherTokenBudget : evidenceBudget;

  const explicitUrls = extractUrls(query).slice(0, MAX_EXPLICIT_URLS);
  const seenUrlKeys = new Set<string>();
  const allNotes: string[] = [];
  const allSources: ResearchSource[] = [];
  let totalSources = 0;

  let failedQueryCount = 0;
  let failedContents = false;
  let fallbackSources = 0;
  const failedStages: string[] = [];
  const currentDegraded = (): DegradedResearch | undefined => {
    const reasons: string[] = [];
    if (failedQueryCount > 0) {
      reasons.push(`${failedQueryCount} search ${failedQueryCount === 1 ? "query" : "queries"} failed`);
    }
    if (failedContents) {
      reasons.push("one or more explicit URLs could not be fetched");
    }
    if (fallbackSources > 0) {
      reasons.push(`${fallbackSources} ${fallbackSources === 1 ? "source" : "sources"} could only be partially read`);
    }
    reasons.push(...failedStages);
    return reasons.length > 0 ? reasons : undefined;
  };

  const stats: ResearchStats = {
    rounds: 0,
    planMs: 0,
    searchMs: 0,
    readMs: 0,
    gapCheckMs: 0,
  };
  const timed = async <T>(
    stage: Exclude<keyof ResearchStats, "rounds">,
    work: () => Promise<T>,
  ): Promise<T> => {
    const startedAt = Date.now();
    try {
      return await work();
    } finally {
      stats[stage] += Date.now() - startedAt;
    }
  };

  const emitStep = (id: string, data: ResearchStepData) => {
    writer.write({ type: "data-research-step", id, data });
  };
  const emitSources = (docs: ExaDocument[]) => {
    for (const doc of docs) {
      writer.write({ type: "source-url", sourceId: crypto.randomUUID(), url: doc.url, title: doc.title });
    }
  };

  // --- Round 1: Plan initial search query ---
  const round1Id = `research-r1-${requestId}`;
  emitStep(round1Id, { round: 1, phase: "planning", sources: [] });

  let initialQuery = "";
  let effectiveQuery = query;
  let skipSearch = false;
  try {
    const parsed = await timed("planMs", () =>
      planner.planQuery({
        messages,
        effortLevel: effort.level,
        signal,
        requestId,
      }),
    );
    if (parsed.brief?.trim()) {
      effectiveQuery = parsed.brief.trim();
    }
    if (parsed.stopped && explicitUrls.length === 0) {
      skipSearch = true;
    } else if (parsed.query) {
      initialQuery = parsed.query;
    } else {
      initialQuery = effectiveQuery.slice(0, MAX_QUERY_LENGTH);
    }
  } catch (error) {
    if (isAbortError(error) || signal?.aborted) throw error;
    logError("query-plan", error, { requestId });
    failedStages.push("query planning failed, so the raw question was searched instead");
    initialQuery = query.slice(0, MAX_QUERY_LENGTH);
  }

  logInfo("research-plan", {
    requestId,
    skipSearch,
    brief: effectiveQuery !== query ? effectiveQuery : undefined,
    query: skipSearch ? undefined : initialQuery,
    explicitUrls: explicitUrls.length,
  });

  if (skipSearch) {
    emitStep(round1Id, { round: 1, phase: "done", sources: [] });
    return { stats, searched: false, evidenceBlock: "", totalSources: 0, sources: [] };
  }

  // --- Strictly sequential single-search rounds ---
  const allQueries: string[] = [];
  const pendingHopUrls: string[] = [];
  const queuedHopKeys = new Set<string>();
  const citedPrimaryQueries: string[] = [];
  const seenCitedQueries = new Set<string>();
  let lastRoundStep:
    | { id: string; round: number; query: string; sources: ResearchSource[]; notes: string }
    | undefined;
  let currentQuery = initialQuery;

  for (let round = 1; round <= effort.rounds; round++) {
    const roundId = `research-r${round}-${requestId}`;
    allQueries.push(currentQuery);
    emitStep(roundId, { round, phase: "searching", query: currentQuery, sources: [] });
    stats.rounds = round;

    const hopUrlsThisRound: string[] = [];
    if (round > 1 && isDeep) {
      while (
        pendingHopUrls.length > 0 &&
        hopUrlsThisRound.length < MAX_HOP_URLS_PER_ROUND
      ) {
        const candidate = pendingHopUrls.shift()!;
        const key = normalizeUrlKey(candidate);
        if (key && !seenUrlKeys.has(key)) {
          hopUrlsThisRound.push(candidate);
        }
      }
    }
    const directFetchUrls = round === 1 ? explicitUrls : hopUrlsThisRound;
    const highlightsQuery = isDeep ? effectiveQuery : undefined;

    const { directOutcome, searchOutcome } = await timed("searchMs", async () => {
      const direct =
        directFetchUrls.length > 0
          ? await search.fetchContents(directFetchUrls, {
              signal,
              requestId,
              ...(docMaxChars ? { maxCharacters: docMaxChars } : {}),
            })
          : { docs: [] as ExaDocument[] };
      const searched = await search.search(currentQuery, roundResultsPerQuery, {
        signal,
        requestId,
        ...(docMaxChars ? { maxCharacters: docMaxChars } : {}),
        ...(highlightsQuery ? { highlightsQuery } : {}),
      });
      return { directOutcome: direct, searchOutcome: searched };
    });

    if (round === 1) {
      if (directOutcome.error) failedContents = true;
      if (explicitUrls.length > 0 && directOutcome.docs.length < explicitUrls.length) {
        failedContents = true;
      }
    }
    if (searchOutcome.error) {
      failedQueryCount += 1;
    }

    const roundCap = Math.min(sourcesPerRound, maxSources - totalSources);
    let roundDocs: ExaDocument[];

    if (isDeep && planner.rerankSources && roundCap > 0) {
      const prioritySelected = selectDeduplicatedDocs(
        directOutcome.docs,
        [],
        seenUrlKeys,
        roundCap,
        { query: effectiveQuery },
      );
      const remainingSlots = roundCap - prioritySelected.length;
      let searchSelected: ExaDocument[] = [];
      if (remainingSlots > 0) {
        const candidatePool = selectDeduplicatedDocs(
          [],
          searchOutcome.docs,
          new Set(seenUrlKeys),
          remainingSlots * 2,
          { query: effectiveQuery },
        );
        if (candidatePool.length > remainingSlots) {
          emitStep(roundId, { round, phase: "reranking", query: currentQuery, sources: [] });
          try {
            searchSelected = await timed("planMs", () =>
              planner.rerankSources!({
                query: effectiveQuery,
                candidates: candidatePool,
                maxSelect: remainingSlots,
                signal,
                requestId,
              }),
            );
          } catch (error) {
            if (isAbortError(error) || signal?.aborted) throw error;
            logError("rerank-sources", error, { requestId, round });
            searchSelected = candidatePool.slice(0, remainingSlots);
          }
        } else {
          searchSelected = candidatePool;
        }
        for (const d of searchSelected) {
          const key = normalizeUrlKey(d.url);
          if (key) seenUrlKeys.add(key);
        }
      }
      roundDocs = [...prioritySelected, ...searchSelected];
    } else {
      roundDocs = selectDeduplicatedDocs(
        directOutcome.docs,
        searchOutcome.docs,
        seenUrlKeys,
        roundCap,
        { query: effectiveQuery },
      );
    }

    if (roundDocs.length === 0) {
      if (round === 1) {
        emitStep(roundId, {
          round,
          phase: "error",
          query: currentQuery,
          sources: [],
          error: "No web sources could be retrieved for this query.",
          degraded: currentDegraded(),
        });
        return { stats, searched: false, searchFailed: true, evidenceBlock: "", totalSources: 0, sources: [], degraded: currentDegraded() };
      }
      emitStep(roundId, {
        round,
        phase: "done",
        query: currentQuery,
        sources: [],
        notes: "_Follow-up query did not surface any additional unseen sources._",
        degraded: currentDegraded(),
      });
      break;
    }

    const roundSources = roundDocs.map(toResearchSource);
    allSources.push(...roundSources);
    emitSources(roundDocs);

    emitStep(roundId, { round, phase: "reading", query: currentQuery, sources: roundSources });

    const condensed = await timed("readMs", () =>
      condenser.condense(roundDocs, {
        query: effectiveQuery,
        batchSize: isDeep ? serverConfig.summary.deepBatchSize : undefined,
        perSourceCharCap: isDeep
          ? serverConfig.summary.deepPerSourceInputCharCap
          : undefined,
        patientWait: isDeep,
        extractPrimaryRefs: isDeep,
        signal,
        requestId,
      }),
    );
    fallbackSources += condensed.fallbackCount;
    allNotes.push(...condensed.notes);
    totalSources += roundDocs.length;
    const notesText = condensed.notes.join("\n\n");
    lastRoundStep = { id: roundId, round, query: currentQuery, sources: roundSources, notes: notesText };

    if (isDeep && condensed.primaryRefs) {
      for (const u of condensed.primaryRefs.urls) {
        const key = normalizeUrlKey(u);
        if (key && !seenUrlKeys.has(key) && !queuedHopKeys.has(key)) {
          queuedHopKeys.add(key);
          pendingHopUrls.push(u);
        }
      }
      for (const cq of condensed.primaryRefs.queries) {
        const norm = cq.toLowerCase().trim();
        if (norm && !seenCitedQueries.has(norm)) {
          seenCitedQueries.add(norm);
          citedPrimaryQueries.push(cq);
        }
      }
    }

    const gatherFull = estimateTokens(allNotes.join("\n\n")) >= gatherBudget;
    const isLastRound = round >= effort.rounds || totalSources >= maxSources || gatherFull;
    if (isLastRound) {
      emitStep(roundId, { round, phase: "done", query: currentQuery, sources: roundSources, notes: notesText, degraded: currentDegraded() });
      break;
    }

    // --- Gap check: is another single-query round needed? ---
    emitStep(roundId, {
      round,
      phase: "checking-gaps",
      query: currentQuery,
      sources: roundSources,
      notes: notesText,
      degraded: currentDegraded(),
    });

    let nextFollowUp: string | undefined;
    try {
      const gapNotes = budgetNotesFairly(
        allNotes,
        serverConfig.gapCheck.notesTokenBudget,
      ).text;
      const priorLower = new Set(allQueries.map((q) => q.toLowerCase()));
      const unqueriedCitations = citedPrimaryQueries
        .filter((cq) => !priorLower.has(cq.toLowerCase()))
        .slice(0, 4);
      const parsedGap = await timed("gapCheckMs", () =>
        planner.planFollowUp({
          query: effectiveQuery,
          priorQueries: allQueries,
          notes: gapNotes,
          effortLevel: effort.level,
          ...(unqueriedCitations.length > 0
            ? { citedPrimaryQueries: unqueriedCitations }
            : {}),
          signal,
          requestId,
        }),
      );
      if (!parsedGap.stopped && parsedGap.query && !priorLower.has(parsedGap.query.toLowerCase())) {
        nextFollowUp = parsedGap.query;
      }
    } catch (error) {
      if (isAbortError(error) || signal?.aborted) throw error;
      logError("gap-check", error, { requestId });
      if (!failedStages.includes("the gap check could not be completed")) {
        failedStages.push("the gap check could not be completed");
      }
    }

    emitStep(roundId, { round, phase: "done", query: currentQuery, sources: roundSources, notes: notesText, degraded: currentDegraded() });
    logDebug("gap-check", { requestId, round, followUpQuery: nextFollowUp });

    if (!nextFollowUp) break;
    currentQuery = nextFollowUp;
  }

  let evidenceBlock: string | undefined;
  const rawJoinedTokens = estimateTokens(allNotes.join("\n\n---\n\n"));
  if (
    isDeep &&
    condenser.reduceNotes &&
    rawJoinedTokens > evidenceBudget
  ) {
    if (lastRoundStep) {
      emitStep(lastRoundStep.id, {
        round: lastRoundStep.round,
        phase: "synthesizing",
        query: lastRoundStep.query,
        sources: lastRoundStep.sources,
        notes: lastRoundStep.notes,
        degraded: currentDegraded(),
      });
    }
    try {
      const distilled = await timed("readMs", () =>
        condenser.reduceNotes!(allNotes, {
          query: effectiveQuery,
          targetTokenBudget: evidenceBudget,
          patientWait: true,
          signal,
          requestId,
        }),
      );
      if (distilled.reduced && distilled.evidenceBlock.trim()) {
        if (estimateTokens(distilled.evidenceBlock) <= evidenceBudget) {
          evidenceBlock = distilled.evidenceBlock;
        } else {
          const capped = budgetNotesFairly([distilled.evidenceBlock], evidenceBudget, {
            trimMarker: "[Note trimmed to fit the answer token budget]",
          });
          evidenceBlock = capped.text;
          if (capped.trimmedCount > 0) {
            failedStages.push(
              "thematic research brief was slightly trimmed to fit the answer token budget",
            );
          }
        }
      }
    } finally {
      if (lastRoundStep) {
        emitStep(lastRoundStep.id, {
          round: lastRoundStep.round,
          phase: "done",
          query: lastRoundStep.query,
          sources: lastRoundStep.sources,
          notes: lastRoundStep.notes,
          degraded: currentDegraded(),
        });
      }
    }
  }

  if (evidenceBlock === undefined) {
    const budgeted = budgetNotesFairly(allNotes, evidenceBudget, {
      separator: "\n\n---\n\n",
      labelSources: true,
      trimMarker: "[Note trimmed to fit the answer token budget]",
    });
    if (budgeted.trimmedCount > 0) {
      failedStages.push(
        `${budgeted.trimmedCount} research ${budgeted.trimmedCount === 1 ? "note was" : "notes were"} trimmed or omitted to fit the answer token budget`,
      );
    }
    evidenceBlock = budgeted.text;
  }

  return {
    stats,
    searched: true,
    evidenceBlock,
    totalSources,
    sources: allSources,
    degraded: currentDegraded(),
  };
}
