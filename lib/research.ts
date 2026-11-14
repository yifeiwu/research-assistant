import "server-only";
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

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

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

  // --- Round 1: Parallel Exa search + explicit URL fetch ---
  emitStep(round1Id, { round: 1, phase: "searching", queries: round1Queries, sources: [] });

  const [explicitOutcome, ...searchOutcomes] = await Promise.all([
    explicitUrls.length > 0
      ? search.fetchContents(explicitUrls, { signal, requestId })
      : Promise.resolve<{ docs: ExaDocument[]; error?: string }>({ docs: [] }),
    ...round1Queries.map((q) => search.search(q, effort.resultsPerQuery, { signal, requestId })),
  ]);
  if (explicitOutcome.error) failedContents = true;
  // Exa can succeed overall yet return fewer documents than requested URLs;
  // that partial loss is degraded too, not just a whole-fetch error.
  if (explicitUrls.length > 0 && explicitOutcome.docs.length < explicitUrls.length) {
    failedContents = true;
  }
  searchOutcomes.forEach((outcome, i) => {
    if (outcome.error) failedQueries.push(round1Queries[i]);
  });

  const round1Docs = selectDeduplicatedDocs(
    explicitOutcome.docs,
    searchOutcomes.map((o) => o.docs),
    seenUrlKeys,
    effort.round1MaxSources,
  );

  if (round1Docs.length === 0) {
    emitStep(round1Id, {
      round: 1,
      phase: "error",
      queries: round1Queries,
      sources: [],
      error: "No web sources could be retrieved for these queries.",
      degraded: currentDegraded(),
    });
    return { searched: false, searchFailed: true, evidenceBlock: "", totalSources: 0, sources: [], degraded: currentDegraded() };
  }

  const round1Sources = round1Docs.map(toResearchSource);
  allSources.push(...round1Sources);
  emitSources(round1Docs);

  // --- Round 1: Map condense ---
  emitStep(round1Id, { round: 1, phase: "reading", queries: round1Queries, sources: round1Sources });

  const round1Condensed = await condenser.condense(round1Docs, { query, signal, requestId });
  fallbackSources += round1Condensed.fallbackCount;
  allNotes.push(...round1Condensed.notes);
  totalSources += round1Docs.length;
  const round1NotesText = round1Condensed.notes.join("\n\n");

  // --- Optional Round 2 (High effort): Gap Check + Follow-up retrieval ---
  const remainingBudget = effort.maxSources - totalSources;
  if (effort.rounds >= 2 && effort.followUpQueries > 0 && remainingBudget > 0) {
    emitStep(round1Id, {
      round: 1,
      phase: "checking-gaps",
      queries: round1Queries,
      sources: round1Sources,
      notes: round1NotesText,
      degraded: currentDegraded(),
    });

    let followUpQueries: string[] = [];
    try {
      const parsedGap = await planner.planFollowUps({
        query,
        priorQueries: round1Queries,
        notes: round1NotesText,
        maxQueries: effort.followUpQueries,
        signal,
        requestId,
      });
      if (!parsedGap.stopped) {
        const priorSet = new Set(round1Queries.map((q) => q.toLowerCase()));
        followUpQueries = parsedGap.queries.filter((q) => !priorSet.has(q.toLowerCase()));
      }
    } catch (error) {
      if (isAbortError(error) || signal?.aborted) throw error;
      logError("gap-check", error, { requestId });
      failedStages.push("the gap check could not be completed");
    }

    emitStep(round1Id, {
      round: 1,
      phase: "done",
      queries: round1Queries,
      sources: round1Sources,
      notes: round1NotesText,
      degraded: currentDegraded(),
    });

    logDebug("gap-check", { requestId, followUpQueries });

    if (followUpQueries.length > 0) {
      const round2Id = `research-r2-${requestId}`;
      emitStep(round2Id, { round: 2, phase: "searching", queries: followUpQueries, sources: [] });

      const round2Outcomes = await Promise.all(
        followUpQueries.map((q) => search.search(q, effort.resultsPerQuery, { signal, requestId })),
      );
      round2Outcomes.forEach((outcome, i) => {
        if (outcome.error) failedQueries.push(followUpQueries[i]);
      });

      const round2Docs = selectDeduplicatedDocs([], round2Outcomes.map((o) => o.docs), seenUrlKeys, remainingBudget);

      if (round2Docs.length > 0) {
        const round2Sources = round2Docs.map(toResearchSource);
        allSources.push(...round2Sources);
        emitSources(round2Docs);
        emitStep(round2Id, { round: 2, phase: "reading", queries: followUpQueries, sources: round2Sources });

        const round2Condensed = await condenser.condense(round2Docs, { query, signal, requestId });
        fallbackSources += round2Condensed.fallbackCount;
        allNotes.push(...round2Condensed.notes);
        totalSources += round2Docs.length;

        emitStep(round2Id, {
          round: 2,
          phase: "done",
          queries: followUpQueries,
          sources: round2Sources,
          notes: round2Condensed.notes.join("\n\n"),
          degraded: currentDegraded(),
        });
      } else {
        emitStep(round2Id, {
          round: 2,
          phase: "done",
          queries: followUpQueries,
          sources: [],
          notes: "_Follow-up queries did not surface any additional unseen sources._",
          degraded: currentDegraded(),
        });
      }
    }
  } else {
    emitStep(round1Id, {
      round: 1,
      phase: "done",
      queries: round1Queries,
      sources: round1Sources,
      notes: round1NotesText,
      degraded: currentDegraded(),
    });
  }

  const evidenceBlock = allNotes.map((note, idx) => `[Source ${idx + 1}]\n${note}`).join("\n\n---\n\n");
  return {
    searched: true,
    evidenceBlock,
    totalSources,
    sources: allSources,
    degraded: currentDegraded(),
  };
}
