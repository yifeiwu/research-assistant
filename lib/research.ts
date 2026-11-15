import "server-only";
import { isAbortError } from "./errors";
import {
  generateText,
  type ModelMessage,
  type UIMessageStreamWriter,
} from "ai";
import type { EffortConfig } from "./effort";
import { createExaClient, type ExaDocument } from "./exa";
import { logDebug, logError, logInfo } from "./logger";
import { groqReasoningOptions } from "./models";
import { condenseSourcesDetailed, stripThinking } from "./pipeline";
import { buildGapCheckPrompt, buildQueryPlanPrompt } from "./prompts";
import { extractUrls, normalizeUrlKey } from "./sources";
import { serverConfig } from "./config";
import { estimateTokens } from "./tokens";
import type { StageRunner } from "./agent/stage";
import type {
  Condenser,
  Planner,
  PortContext,
  ResearchDeps,
  SearchProvider,
} from "./ports";
import type {
  ChatUIMessage,
  DegradedResearch,
  ResearchSource,
  ResearchStepData,
} from "./types/chat";

const MAX_EXPLICIT_URLS = 4;
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
  /** True when search was attempted but no sources could be retrieved at all.
   * Distinct from `searched: false` via NO_SEARCH/low effort, so the caller
   * can disclose the failure instead of answering as if search was unneeded. */
  searchFailed?: boolean;
  evidenceBlock: string;
  totalSources: number;
  sources: ResearchSource[];
  degraded?: DegradedResearch;
};


/**
 * Parse newline-separated plain-text queries from a model output, tolerating
 * inline `<think>` blocks, bullets, numbering, quotes, and preamble lines.
 */
export function parsePlainTextLines(
  raw: string,
  opts: { stopToken: string; maxLines: number },
): { stopped: boolean; lines: string[] } {
  const cleaned = stripThinking(raw);
  if (!cleaned) return { stopped: false, lines: [] };

  const rawLines = cleaned
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (
    rawLines.length === 1 &&
    new RegExp(`^[\`"']*${opts.stopToken}[\`"'.!]*$`, "i").test(rawLines[0])
  ) {
    return { stopped: true, lines: [] };
  }

  const out: string[] = [];
  const seen = new Set<string>();
  for (const rawLine of rawLines) {
    if (rawLine.startsWith("```")) continue;
    if (/^(here are|search queries|follow-up queries|queries)\b.*:$/i.test(rawLine)) continue;
    const normalized = rawLine
      .replace(/^(?:[-*•]+|\d+[.)])\s*/, "")
      .replace(/^["'`]+|["'`]+$/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!normalized) continue;
    if (new RegExp(`^${opts.stopToken}[.!]*$`, "i").test(normalized)) {
      if (out.length === 0) return { stopped: true, lines: [] };
      continue;
    }
    if (normalized.length < 2) continue;
    const clipped = normalized.slice(0, MAX_QUERY_LENGTH);
    const key = clipped.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clipped);
    if (out.length >= opts.maxLines) break;
  }
  return { stopped: false, lines: out };
}

/**
 * Parse Stage 1 query-planner output containing an optional `BRIEF: ...` line
 * followed by newline-separated search queries, or `NO_SEARCH`.
 */
export function parseQueryPlan(
  raw: string,
  opts: { maxQueries: number },
): { stopped: boolean; brief?: string; queries: string[] } {
  const cleaned = stripThinking(raw);
  if (!cleaned) return { stopped: false, queries: [] };

  const rawLines = cleaned
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (
    rawLines.length === 1 &&
    /^[\`"']*NO_SEARCH[\`"'.!]*$/i.test(rawLines[0])
  ) {
    return { stopped: true, queries: [] };
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
        return { stopped: true, queries: [] };
      }
    }
    remainingLines.push(line);
  }

  const parsed = parsePlainTextLines(remainingLines.join("\n"), {
    stopToken: "NO_SEARCH",
    maxLines: opts.maxQueries,
  });
  if (parsed.stopped && !brief) {
    return { stopped: true, queries: [] };
  }
  return {
    stopped: false,
    ...(brief ? { brief } : {}),
    queries: parsed.lines,
  };
}

const QUERY_STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "what", "when",
  "where", "which", "who", "whom", "whose", "why", "how", "are", "was",
  "were", "been", "being", "have", "has", "had", "does", "did", "will",
  "would", "could", "should", "into", "about", "over", "after", "before",
  "between", "under", "again", "further", "then", "once", "here", "there",
  "all", "any", "both", "each", "few", "more", "most", "other", "some",
  "such", "only", "own", "same", "than", "too", "very", "can", "just",
]);

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

function extractQueryTerms(query: string): string[] {
  const matches = query.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [];
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const token of matches) {
    if (QUERY_STOPWORDS.has(token) || seen.has(token)) continue;
    seen.add(token);
    terms.push(token);
  }
  return terms;
}

function rankBatchCandidates(docs: ExaDocument[], query?: string): ExaDocument[] {
  const nonEmpty = docs.filter((d) => d.text.trim().length > 0);
  if (!query || !query.trim() || nonEmpty.length <= 1) return nonEmpty;

  const terms = extractQueryTerms(query);
  const freshnessSensitive = /\b(latest|recent|current|today|new|update|updated|202[4-9])\b/i.test(query);
  const nowMs = Date.now();

  const scored = nonEmpty.map((doc, idx) => {
    // Base rank decay preserves Exa's ordering unless lexical/data/recency signals strongly favor another hit.
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
 * Interleave search results round-robin across queries while deduplicating
 * against `seenUrlKeys`, dropping empty pages, and preferring substantive,
 * domain-diverse sources before backfilling remaining slots.
 */
export function selectDeduplicatedDocs(
  priorityDocs: ExaDocument[],
  queryResultBatches: ExaDocument[][],
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

  // Explicit user-supplied URLs always take priority regardless of length/domain caps.
  for (const doc of priorityDocs) {
    if (selected.length >= maxCount) break;
    const key = normalizeUrlKey(doc.url);
    if (!key || seenUrlKeys.has(key)) continue;
    recordDoc(doc, key, registrableDomain(doc.url));
  }

  // Filter out completely empty search results and rank within each query batch.
  const rankedBatches = queryResultBatches.map((batch) =>
    rankBatchCandidates(batch, opts?.query),
  );
  const maxDepth = rankedBatches.reduce((max, batch) => Math.max(max, batch.length), 0);

  // Pass 1: Substantive pages respecting per-domain diversity cap.
  for (let depth = 0; depth < maxDepth && selected.length < maxCount; depth++) {
    for (const batch of rankedBatches) {
      if (selected.length >= maxCount) break;
      if (depth >= batch.length) continue;
      const doc = batch[depth];
      if (doc.text.trim().length < minSubstantiveChars) continue;
      const key = normalizeUrlKey(doc.url);
      if (!key || seenUrlKeys.has(key)) continue;
      const domain = registrableDomain(doc.url);
      if ((domainCounts.get(domain) ?? 0) >= maxPerDomain) continue;
      recordDoc(doc, key, domain);
    }
  }

  // Pass 2 (Backfill): Relax domain and minimum-length thresholds for sparse/short results.
  if (selected.length < maxCount) {
    for (let depth = 0; depth < maxDepth && selected.length < maxCount; depth++) {
      for (const batch of rankedBatches) {
        if (selected.length >= maxCount) break;
        if (depth >= batch.length) continue;
        const doc = batch[depth];
        const key = normalizeUrlKey(doc.url);
        if (!key || seenUrlKeys.has(key)) continue;
        recordDoc(doc, key, registrableDomain(doc.url));
      }
    }
  }

  return selected;
}

const IRRELEVANT_NOTE_RE =
  /(?:^|\n)\s*-\s*Irrelevant to research question\.?\s*$/i;

/**
 * Water-filling fair-share token budgeter across research notes.
 *
 * Unlike sequential front-slicing (which drops later gap-filling rounds when an
 * earlier source produced a long fallback excerpt), short notes keep their full
 * text and donate unused budget to longer notes, while off-topic notes flagged
 * `- Irrelevant to research question.` are shed first when over budget.
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
    irrelevant: IRRELEVANT_NOTE_RE.test(note.trim()),
  }));

  const fullJoined = items.map((it) => it.formatted).join(sep);
  if (fullJoined.length <= charBudget) {
    return { text: fullJoined, trimmedCount: 0 };
  }

  // Shed explicitly irrelevant notes first when over budget, provided at least one relevant note exists.
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

  // Iterative water-filling: lock any note that fits within the current equal share.
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

  // Distribute remaining pool evenly across oversized notes.
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

function toResearchSource(doc: ExaDocument): ResearchSource {
  return { url: doc.url, title: doc.title, publishedDate: doc.publishedDate };
}

/**
 * Planner adapter backed by plain-text `generateText` calls. Each call first
 * leases its tokens from the shared model budgets (waiting for the window or
 * switching model); a denied lease throws and the pipeline degrades exactly
 * as it does for a failed planner call.
 */
function createTextPlanner(stage: StageRunner): Planner {
  return {
    async planQueries({ messages, maxQueries, signal }) {
      const system = buildQueryPlanPrompt(maxQueries);
      const leased = await stage.lease({
        estInputTokens: estimateTokens(system) + estimateTokens(JSON.stringify(messages)),
        maxOutputTokens: serverConfig.planner.maxOutputTokens,
        signal,
      });
      const result = await generateText({
        model: leased.model,
        system,
        messages,
        maxOutputTokens: serverConfig.planner.maxOutputTokens,
        providerOptions: groqReasoningOptions(leased.modelId, "auxiliary"),
        abortSignal: signal,
        timeout: { totalMs: serverConfig.planner.timeoutMs },
        maxRetries: 0,
      });
      const parsed = parseQueryPlan(result.text, { maxQueries });
      return { stopped: parsed.stopped, brief: parsed.brief, queries: parsed.queries };
    },
    async planFollowUps({ query, priorQueries, notes, maxQueries, effortLevel, signal }) {
      const system = buildGapCheckPrompt(maxQueries, effortLevel);
      const prompt = `User question:\n${query}\n\nQueries already run:\n${priorQueries.map((q) => `- ${q}`).join("\n")}\n\nGathered research notes so far:\n${notes}\n\nDecide whether these notes are sufficient ("DONE") or list up to ${maxQueries} follow-up search queries (one per line).`;
      const leased = await stage.lease({
        estInputTokens: estimateTokens(system) + estimateTokens(prompt),
        maxOutputTokens: serverConfig.gapCheck.maxOutputTokens,
        signal,
      });
      const result = await generateText({
        model: leased.model,
        system,
        maxOutputTokens: serverConfig.gapCheck.maxOutputTokens,
        providerOptions: groqReasoningOptions(leased.modelId, "auxiliary"),
        abortSignal: signal,
        timeout: { totalMs: serverConfig.gapCheck.timeoutMs },
        maxRetries: 0,
        prompt,
      });
      const parsed = parsePlainTextLines(result.text, { stopToken: "DONE", maxLines: maxQueries });
      return { stopped: parsed.stopped, queries: parsed.lines };
    },
  };
}

/** SearchProvider adapter backed by the cached Exa client. */
function createExaSearchProvider(ctx: PortContext & { threadId?: string }): SearchProvider {
  const exa = createExaClient({
    signal: ctx.signal,
    requestId: ctx.requestId,
    threadId: ctx.threadId,
  });
  return {
    search: (query, numResults) => exa.searchDetailed(query, numResults),
    fetchContents: (urls) => exa.fetchDetailed(urls),
  };
}

/** Condenser adapter backed by the Groq summary model. */
function createModelCondenser(stage: StageRunner): Condenser {
  return {
    condense: (docs, input) =>
      condenseSourcesDetailed(docs, {
        stage,
        query: input.query,
        signal: input.signal,
        requestId: input.requestId,
      }),
  };
}

/**
 * Execute the deterministic multi-stage research pipeline through the thin
 * Planner / SearchProvider / Condenser ports, emitting live
 * `data-research-step` and `source-url` UI stream chunks along the way.
 */
export async function runResearchPipeline(opts: {
  messages: ModelMessage[];
  query: string;
  effort: EffortConfig;
  /**
   * Where the pipeline gets its models (see lib/agent/stage.ts): `planner`
   * for query planning and gap checks, `summary` for the batched summariser.
   */
  stages: { planner: StageRunner; summary: StageRunner };
  writer: UIMessageStreamWriter<ChatUIMessage>;
  signal?: AbortSignal;
  requestId: string;
  /**
   * Conversation the turn belongs to. Searches are limited to 2 in parallel
   * per thread (see lib/exa.ts); without one the limit is per call.
   */
  threadId?: string;
  deps?: Partial<ResearchDeps>;
}): Promise<ResearchOutcome> {
  const { messages, query, effort, writer, signal, requestId } = opts;
  const { initialQueries, resultsPerQuery, sourcesPerRound, maxSources } =
    serverConfig.research;

  if (effort.rounds === 0 || !query.trim()) {
    return { searched: false, evidenceBlock: "", totalSources: 0, sources: [] };
  }

  const planner = opts.deps?.planner ?? createTextPlanner(opts.stages.planner);
  const search =
    opts.deps?.search ??
    createExaSearchProvider({ signal, requestId, threadId: opts.threadId });
  const condenser = opts.deps?.condenser ?? createModelCondenser(opts.stages.summary);

  const explicitUrls = extractUrls(query).slice(0, MAX_EXPLICIT_URLS);
  const seenUrlKeys = new Set<string>();
  const allNotes: string[] = [];
  const allSources: ResearchSource[] = [];
  let totalSources = 0;

  const failedQueries: string[] = [];
  let failedContents = false;
  let fallbackSources = 0;
  const failedStages: string[] = [];
  const currentDegraded = (): DegradedResearch | undefined => {
    if (failedQueries.length === 0 && !failedContents && fallbackSources === 0 && failedStages.length === 0) return undefined;
    const messagesOut: string[] = [];
    if (failedQueries.length > 0) messagesOut.push(`${failedQueries.length} search ${failedQueries.length === 1 ? "query" : "queries"} failed`);
    if (failedContents) messagesOut.push("one or more explicit URLs could not be fetched");
    if (fallbackSources > 0) messagesOut.push(`${fallbackSources} ${fallbackSources === 1 ? "source" : "sources"} could only be partially read`);
    messagesOut.push(...failedStages);
    return {
      failedQueries: [...failedQueries],
      failedContents,
      fallbackSources,
      failedStages: [...failedStages],
      messages: messagesOut,
    };
  };

  const stats: ResearchStats = {
    rounds: 0,
    planMs: 0,
    searchMs: 0,
    readMs: 0,
    gapCheckMs: 0,
  };
  /** Run one stage's work, adding the time it took to that stage's total. */
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

  // --- Round 1: Plan queries ---
  const round1Id = `research-r1-${requestId}`;
  emitStep(round1Id, { round: 1, phase: "planning", queries: [], sources: [] });

  const plannedInitialQueries =
    effort.initialQueries > 0 ? effort.initialQueries : initialQueries;
  let round1Queries: string[] = [];
  let effectiveQuery = query;
  let skipSearch = false;
  try {
    const parsed = await timed("planMs", () =>
      planner.planQueries({
        messages,
        maxQueries: plannedInitialQueries,
        signal,
        requestId,
      }),
    );
    if (parsed.brief?.trim()) {
      effectiveQuery = parsed.brief.trim();
    }
    if (parsed.stopped && explicitUrls.length === 0) {
      skipSearch = true;
    } else if (parsed.queries.length > 0) {
      round1Queries = parsed.queries;
    } else if (!parsed.stopped) {
      round1Queries = [effectiveQuery.slice(0, MAX_QUERY_LENGTH)];
    }
  } catch (error) {
    if (isAbortError(error) || signal?.aborted) throw error;
    logError("query-plan", error, { requestId });
    failedStages.push("query planning failed, so the raw question was searched instead");
    round1Queries = [query.slice(0, MAX_QUERY_LENGTH)];
  }

  logInfo("research-plan", {
    requestId,
    skipSearch,
    brief: effectiveQuery !== query ? effectiveQuery : undefined,
    queries: round1Queries,
    explicitUrls: explicitUrls.length,
  });

  if (skipSearch) {
    emitStep(round1Id, { round: 1, phase: "done", queries: [], sources: [] });
    return { stats, searched: false, evidenceBlock: "", totalSources: 0, sources: [] };
  }

  // --- Sequential retrieval rounds ---
  // A round issues all of its searches at once; the Exa client lets at most
  // 2 run in parallel per thread and queues the rest. Depth comes from
  // looping: a gap check over all notes so far decides whether another,
  // narrower round is worth running.
  const allQueries: string[] = [];
  const evidenceBudget = serverConfig.synthesis.evidenceTokenBudget;
  let nextQueries = round1Queries;

  for (let round = 1; round <= effort.rounds; round++) {
    const roundId = `research-r${round}-${requestId}`;
    const queries = nextQueries;
    allQueries.push(...queries);
    emitStep(roundId, { round, phase: "searching", queries, sources: [] });
    stats.rounds = round;

    // Explicit URLs are fetched once, alongside Round 1's searches.
    const [explicitOutcome, ...searchOutcomes] = await timed("searchMs", () =>
      Promise.all([
        round === 1 && explicitUrls.length > 0
          ? search.fetchContents(explicitUrls, { signal, requestId })
          : Promise.resolve<{ docs: ExaDocument[]; error?: string }>({ docs: [] }),
        ...queries.map((q) => search.search(q, resultsPerQuery, { signal, requestId })),
      ]),
    );
    if (round === 1) {
      if (explicitOutcome.error) failedContents = true;
      // Exa can succeed overall yet return fewer documents than requested
      // URLs; that partial loss is degraded too, not just a whole-fetch error.
      if (explicitUrls.length > 0 && explicitOutcome.docs.length < explicitUrls.length) {
        failedContents = true;
      }
    }
    searchOutcomes.forEach((outcome, i) => {
      if (outcome.error) failedQueries.push(queries[i]);
    });

    const roundDocs = selectDeduplicatedDocs(
      round === 1 ? explicitOutcome.docs : [],
      searchOutcomes.map((o) => o.docs),
      seenUrlKeys,
      Math.min(sourcesPerRound, maxSources - totalSources),
      { query: effectiveQuery },
    );

    if (roundDocs.length === 0) {
      if (round === 1) {
        emitStep(roundId, {
          round,
          phase: "error",
          queries,
          sources: [],
          error: "No web sources could be retrieved for these queries.",
          degraded: currentDegraded(),
        });
        return { stats, searched: false, searchFailed: true, evidenceBlock: "", totalSources: 0, sources: [], degraded: currentDegraded() };
      }
      emitStep(roundId, {
        round,
        phase: "done",
        queries,
        sources: [],
        notes: "_Follow-up queries did not surface any additional unseen sources._",
        degraded: currentDegraded(),
      });
      break;
    }

    const roundSources = roundDocs.map(toResearchSource);
    allSources.push(...roundSources);
    emitSources(roundDocs);

    // --- Map condense (one batched summarizer call per round) ---
    emitStep(roundId, { round, phase: "reading", queries, sources: roundSources });

    const condensed = await timed("readMs", () =>
      condenser.condense(roundDocs, { query: effectiveQuery, signal, requestId }),
    );
    fallbackSources += condensed.fallbackCount;
    allNotes.push(...condensed.notes);
    totalSources += roundDocs.length;
    const notesText = condensed.notes.join("\n\n");

    // Once the gathered notes already fill the synthesis evidence budget,
    // further rounds cannot be used by the answer anyway — stop instead of
    // spending more planner/summarizer calls (and TPM) on trimmed evidence.
    const evidenceFull = estimateTokens(allNotes.join("\n\n")) >= evidenceBudget;
    const isLastRound = round >= effort.rounds || totalSources >= maxSources || evidenceFull;
    if (isLastRound || effort.followUpQueries <= 0) {
      emitStep(roundId, { round, phase: "done", queries, sources: roundSources, notes: notesText, degraded: currentDegraded() });
      break;
    }

    // --- Gap check: is another, narrower round needed? ---
    emitStep(roundId, {
      round,
      phase: "checking-gaps",
      queries,
      sources: roundSources,
      notes: notesText,
      degraded: currentDegraded(),
    });

    let followUpQueries: string[] = [];
    try {
      const gapNotes = budgetNotesFairly(
        allNotes,
        serverConfig.gapCheck.notesTokenBudget,
      ).text;
      const parsedGap = await timed("gapCheckMs", () =>
        planner.planFollowUps({
          query: effectiveQuery,
          priorQueries: allQueries,
          notes: gapNotes,
          maxQueries: effort.followUpQueries,
          effortLevel: effort.level,
          signal,
          requestId,
        }),
      );
      if (!parsedGap.stopped) {
        const priorSet = new Set(allQueries.map((q) => q.toLowerCase()));
        followUpQueries = parsedGap.queries.filter((q) => !priorSet.has(q.toLowerCase()));
      }
    } catch (error) {
      if (isAbortError(error) || signal?.aborted) throw error;
      logError("gap-check", error, { requestId });
      if (!failedStages.includes("the gap check could not be completed")) {
        failedStages.push("the gap check could not be completed");
      }
    }

    emitStep(roundId, { round, phase: "done", queries, sources: roundSources, notes: notesText, degraded: currentDegraded() });
    logDebug("gap-check", { requestId, round, followUpQueries });

    if (followUpQueries.length === 0) break;
    nextQueries = followUpQueries;
  }

  // Assemble synthesis evidence via water-filling fair-share budgeting so short
  // notes from later gap-filling rounds are never dropped behind a long Round 1
  // fallback excerpt. Trimming is disclosed via `degraded`.
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
  const evidenceBlock = budgeted.text;
  return {
    stats,
    searched: true,
    evidenceBlock,
    totalSources,
    sources: allSources,
    degraded: currentDegraded(),
  };
}
