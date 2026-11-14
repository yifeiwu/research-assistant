import "server-only";
import { isAbortError } from "./errors";
import {
  generateText,
  type LanguageModel,
  type ModelMessage,
  type UIMessageStreamWriter,
} from "ai";
import type { GroqProviderOptions } from "@ai-sdk/groq";
import type { EffortConfig } from "./effort";
import { createExaClient, type ExaDocument } from "./exa";
import { logDebug, logError, logInfo } from "./logger";
import { condenseSourcesDetailed, stripThinking } from "./pipeline";
import { buildGapCheckPrompt, buildQueryPlanPrompt } from "./prompts";
import { extractUrls, normalizeUrlKey } from "./sources";
import { serverConfig } from "./config";
import { estimateTokens, truncateToTokenBudget } from "./tokens";
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

export type ResearchOutcome = {
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
 * Interleave search results round-robin across queries while deduplicating
 * against `seenUrlKeys` so every query angle gets fair representation.
 */
export function selectDeduplicatedDocs(
  priorityDocs: ExaDocument[],
  queryResultBatches: ExaDocument[][],
  seenUrlKeys: Set<string>,
  maxCount: number,
): ExaDocument[] {
  const selected: ExaDocument[] = [];
  const tryAdd = (doc: ExaDocument) => {
    if (selected.length >= maxCount) return;
    const key = normalizeUrlKey(doc.url);
    if (!key || seenUrlKeys.has(key)) return;
    seenUrlKeys.add(key);
    selected.push(doc);
  };
  for (const doc of priorityDocs) tryAdd(doc);
  const maxDepth = queryResultBatches.reduce((max, batch) => Math.max(max, batch.length), 0);
  for (let depth = 0; depth < maxDepth && selected.length < maxCount; depth++) {
    for (const batch of queryResultBatches) {
      if (depth < batch.length) tryAdd(batch[depth]);
    }
  }
  return selected;
}

function toResearchSource(doc: ExaDocument): ResearchSource {
  return { url: doc.url, title: doc.title, publishedDate: doc.publishedDate };
}

/** Planner adapter backed by plain-text `generateText` calls. */
function createTextPlanner(opts: {
  model: LanguageModel;
  supportsReasoning: boolean;
}): Planner {
  const reasoningOpts = opts.supportsReasoning
    ? { groq: { reasoningFormat: "parsed" } satisfies GroqProviderOptions }
    : undefined;
  return {
    async planQueries({ messages, maxQueries, signal }) {
      const result = await generateText({
        model: opts.model,
        system: buildQueryPlanPrompt(maxQueries),
        messages,
        maxOutputTokens: serverConfig.planner.maxOutputTokens,
        providerOptions: reasoningOpts,
        abortSignal: signal,
        timeout: { totalMs: serverConfig.planner.timeoutMs },
        maxRetries: 1,
      });
      const parsed = parsePlainTextLines(result.text, { stopToken: "NO_SEARCH", maxLines: maxQueries });
      return { stopped: parsed.stopped, queries: parsed.lines };
    },
    async planFollowUps({ query, priorQueries, notes, maxQueries, signal }) {
      const result = await generateText({
        model: opts.model,
        system: buildGapCheckPrompt(maxQueries),
        maxOutputTokens: serverConfig.gapCheck.maxOutputTokens,
        providerOptions: reasoningOpts,
        abortSignal: signal,
        timeout: { totalMs: serverConfig.gapCheck.timeoutMs },
        maxRetries: 1,
        prompt: `User question:\n${query}\n\nQueries already run:\n${priorQueries.map((q) => `- ${q}`).join("\n")}\n\nGathered research notes so far:\n${notes}\n\nDecide whether these notes are sufficient ("DONE") or list up to ${maxQueries} follow-up search queries (one per line).`,
      });
      const parsed = parsePlainTextLines(result.text, { stopToken: "DONE", maxLines: maxQueries });
      return { stopped: parsed.stopped, queries: parsed.lines };
    },
  };
}

/** SearchProvider adapter backed by the cached Exa client. */
function createExaSearchProvider(ctx: PortContext): SearchProvider {
  const exa = createExaClient({ signal: ctx.signal, requestId: ctx.requestId });
  return {
    search: (query, numResults) => exa.searchDetailed(query, numResults),
    fetchContents: (urls) => exa.fetchDetailed(urls),
  };
}

/** Condenser adapter backed by the Groq summary model. */
function createModelCondenser(opts: {
  model: LanguageModel;
  modelId?: string;
}): Condenser {
  return {
    condense: (docs, input) =>
      condenseSourcesDetailed(docs, {
        model: opts.model,
        query: input.query,
        signal: input.signal,
        requestId: input.requestId,
        modelId: opts.modelId,
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
  mainModel: LanguageModel;
  summaryModel: LanguageModel;
  summaryModelId?: string;
  supportsReasoning: boolean;
  writer: UIMessageStreamWriter<ChatUIMessage>;
  signal?: AbortSignal;
  requestId: string;
  deps?: Partial<ResearchDeps>;
}): Promise<ResearchOutcome> {
  const { messages, query, effort, writer, signal, requestId } = opts;

  if (effort.rounds === 0 || !query.trim()) {
    return { searched: false, evidenceBlock: "", totalSources: 0, sources: [] };
  }

  const planner = opts.deps?.planner ?? createTextPlanner({ model: opts.mainModel, supportsReasoning: opts.supportsReasoning });
  const search = opts.deps?.search ?? createExaSearchProvider({ signal, requestId });
  const condenser = opts.deps?.condenser ?? createModelCondenser({ model: opts.summaryModel, modelId: opts.summaryModelId });

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

  let round1Queries: string[] = [];
  let skipSearch = false;
  try {
    const parsed = await planner.planQueries({ messages, maxQueries: effort.queriesPerRound, signal, requestId });
    if (parsed.stopped && explicitUrls.length === 0) {
      skipSearch = true;
    } else if (parsed.queries.length > 0) {
      round1Queries = parsed.queries;
    } else if (!parsed.stopped) {
      round1Queries = [query.slice(0, MAX_QUERY_LENGTH)];
    }
  } catch (error) {
    if (isAbortError(error) || signal?.aborted) throw error;
    logError("query-plan", error, { requestId });
    failedStages.push("query planning failed, so the raw question was searched instead");
    round1Queries = [query.slice(0, MAX_QUERY_LENGTH)];
  }

  logInfo("research-plan", { requestId, skipSearch, queries: round1Queries, explicitUrls: explicitUrls.length });

  if (skipSearch) {
    emitStep(round1Id, { round: 1, phase: "done", queries: [], sources: [] });
    return { searched: false, evidenceBlock: "", totalSources: 0, sources: [] };
  }

  // --- Sequential retrieval rounds ---
  // Each round runs at most `queriesPerRound` / `followUpQueries` searches in
  // parallel (further bounded by the Exa client's per-request concurrency
  // cap); depth comes from looping — a gap check over all notes so far
  // decides whether another, narrower round is worth running — rather than
  // widening any single round's parallel burst.
  const allQueries: string[] = [];
  const evidenceBudget = serverConfig.synthesis.evidenceTokenBudget;
  let nextQueries = round1Queries;

  for (let round = 1; round <= effort.rounds; round++) {
    const roundId = `research-r${round}-${requestId}`;
    const queries = nextQueries;
    allQueries.push(...queries);
    emitStep(roundId, { round, phase: "searching", queries, sources: [] });

    // Explicit URLs are fetched once, alongside Round 1's searches.
    const [explicitOutcome, ...searchOutcomes] = await Promise.all([
      round === 1 && explicitUrls.length > 0
        ? search.fetchContents(explicitUrls, { signal, requestId })
        : Promise.resolve<{ docs: ExaDocument[]; error?: string }>({ docs: [] }),
      ...queries.map((q) => search.search(q, effort.resultsPerQuery, { signal, requestId })),
    ]);
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
      Math.min(effort.sourcesPerRound, effort.maxSources - totalSources),
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
        return { searched: false, searchFailed: true, evidenceBlock: "", totalSources: 0, sources: [], degraded: currentDegraded() };
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

    const condensed = await condenser.condense(roundDocs, { query, signal, requestId });
    fallbackSources += condensed.fallbackCount;
    allNotes.push(...condensed.notes);
    totalSources += roundDocs.length;
    const notesText = condensed.notes.join("\n\n");

    // Once the gathered notes already fill the synthesis evidence budget,
    // further rounds cannot be used by the answer anyway — stop instead of
    // spending more planner/summarizer calls (and TPM) on trimmed evidence.
    const evidenceFull = estimateTokens(allNotes.join("\n\n")) >= evidenceBudget;
    const isLastRound = round >= effort.rounds || totalSources >= effort.maxSources || evidenceFull;
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
      const parsedGap = await planner.planFollowUps({
        query,
        priorQueries: allQueries,
        notes: truncateToTokenBudget(allNotes.join("\n\n"), serverConfig.gapCheck.notesTokenBudget),
        maxQueries: effort.followUpQueries,
        signal,
        requestId,
      });
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

  // Assemble the synthesis evidence under a token budget: whole notes are
  // included in source order until the budget is hit, the note that crosses
  // it is truncated, and any remaining notes are dropped. Trimming is
  // disclosed via the degraded channel so synthesis can say evidence was cut.
  const evidenceParts: string[] = [];
  let usedTokens = 0;
  let trimmedNotes = 0;
  for (const [idx, note] of allNotes.entries()) {
    const part = `[Source ${idx + 1}]\n${note}`;
    const partTokens = estimateTokens(part);
    if (usedTokens + partTokens <= evidenceBudget) {
      evidenceParts.push(part);
      usedTokens += partTokens;
      continue;
    }
    const remaining = evidenceBudget - usedTokens;
    if (remaining >= 100) {
      evidenceParts.push(
        `${truncateToTokenBudget(part, remaining)}\n[Note trimmed to fit the answer token budget]`,
      );
    }
    // Every note from `idx` onward was truncated or dropped entirely.
    trimmedNotes = allNotes.length - idx;
    break;
  }
  if (trimmedNotes > 0) {
    failedStages.push(
      `${trimmedNotes} research ${trimmedNotes === 1 ? "note was" : "notes were"} trimmed or omitted to fit the answer token budget`,
    );
  }
  const evidenceBlock = evidenceParts.join("\n\n---\n\n");
  return {
    searched: true,
    evidenceBlock,
    totalSources,
    sources: allSources,
    degraded: currentDegraded(),
  };
}
