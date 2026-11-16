import "server-only";
import { isAbortError } from "./errors";
import type { ModelMessage } from "ai";
import type { EffortConfig, EffortLevel } from "./effort";
import {
  createExaClient,
  type ExaDocument,
  type ExaSearchOutcome,
  type ExaSearchRequestOptions,
} from "./exa";
import { logDebug, logError, logInfo } from "./logger";
import {
  condenseSourcesDetailed,
  isIrrelevantNote,
  stripThinking,
  type CondenseSourcesOutcome,
} from "./pipeline";
import { buildGapCheckPrompt, buildQueryPlanPrompt } from "./prompts";
import { extractUrls, normalizeUrlKey } from "./sources";
import { serverConfig } from "./config";
import { estimateTokens } from "./tokens";
import { generateAuxiliaryText, type StageRunner } from "./agent/stage";
import type {
  DegradedResearch,
  ResearchSource,
  ResearchStepData,
} from "./types/chat";

type StepContext = { signal?: AbortSignal; requestId?: string };

export interface Planner {
  planQuery(
    input: { messages: ModelMessage[] } & StepContext,
  ): Promise<{ stopped: boolean; brief?: string; query?: string }>;
  planFollowUp(
    input: {
      query: string;
      priorQueries: string[];
      notes: string;
      effortLevel?: EffortLevel;
    } & StepContext,
  ): Promise<{ stopped: boolean; query?: string }>;
}

export interface SearchProvider {
  search(
    query: string,
    numResults: number,
    ctx: StepContext & ExaSearchRequestOptions,
  ): Promise<ExaSearchOutcome>;
  fetchContents(
    urls: string[],
    ctx: StepContext & ExaSearchRequestOptions,
  ): Promise<ExaSearchOutcome>;
}

export interface Condenser {
  condense(
    docs: ExaDocument[],
    input: {
      query: string;
      batchSize?: number;
      perSourceCharCap?: number;
    } & StepContext,
  ): Promise<CondenseSourcesOutcome>;
}

export type ResearchDeps = {
  planner: Planner;
  search: SearchProvider;
  condenser: Condenser;
};

const MAX_EXPLICIT_URLS = 4;
const MAX_QUERY_LENGTH = 240;
const MAX_BRIEF_LENGTH = 360;

export type ResearchOutcome = {
  searched: boolean;
  searchFailed?: boolean;
  evidenceBlock: string;
  totalSources: number;
  sources: ResearchSource[];
  steps: ResearchStepData[];
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
    if (
      /^(here (?:is|are)|search quer(?:y|ies)|follow-up quer(?:y|ies)|quer(?:y|ies))\b.*:$/i.test(
        rawLine,
      )
    ) {
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

export type SelectDocsOptions = {
  maxPerDomain?: number;
  minSubstantiveChars?: number;
};

function docContentLength(doc: ExaDocument): number {
  const hlLen = (doc.highlights ?? []).reduce((sum, h) => sum + h.trim().length, 0);
  return Math.max(doc.text.trim().length, hlLen);
}

/**
 * Select up to `maxCount` unique documents in Exa's native relevance order,
 * deduplicating against `seenUrlKeys`, dropping empty pages, and preferring
 * domain-diverse sources before backfilling remaining slots.
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
  const minSubstantiveChars = opts?.minSubstantiveChars ?? 120;

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

  const nonEmpty = searchDocs.filter((d) => docContentLength(d) > 0);

  for (const doc of nonEmpty) {
    if (selected.length >= maxCount) break;
    if (docContentLength(doc) < minSubstantiveChars) continue;
    const key = normalizeUrlKey(doc.url);
    if (!key || seenUrlKeys.has(key)) continue;
    const domain = registrableDomain(doc.url);
    if ((domainCounts.get(domain) ?? 0) >= maxPerDomain) continue;
    recordDoc(doc, key, domain);
  }

  if (selected.length < maxCount) {
    for (const doc of nonEmpty) {
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

function toResearchSource(doc: ExaDocument): ResearchSource {
  return { url: doc.url, title: doc.title, publishedDate: doc.publishedDate };
}

function createTextPlanner(stage: StageRunner): Planner {
  return {
    async planQuery({ messages, signal }) {
      const text = await generateAuxiliaryText({
        stage,
        system: buildQueryPlanPrompt(),
        messages,
        maxOutputTokens: serverConfig.planner.maxOutputTokens,
        timeoutMs: serverConfig.planner.timeoutMs,
        signal,
      });
      return parseQueryPlan(text);
    },
    async planFollowUp({ query, priorQueries, notes, effortLevel, signal }) {
      const prompt = `User question:\n${query}\n\nQueries already run:\n${priorQueries.map((q) => `- ${q}`).join("\n")}\n\nGathered research notes so far:\n${notes}\n\nDecide whether these notes are sufficient ("DONE") or output ONE targeted follow-up search query.`;
      const text = await generateAuxiliaryText({
        stage,
        system: buildGapCheckPrompt(effortLevel),
        prompt,
        maxOutputTokens: serverConfig.gapCheck.maxOutputTokens,
        timeoutMs: serverConfig.gapCheck.timeoutMs,
        signal,
      });
      return parsePlainTextQuery(text, {
        stopToken: "DONE",
        exclude: priorQueries,
      });
    },
  };
}

/**
 * Execute the deterministic multi-stage research pipeline, reporting durable
 * `ResearchStepData[]` and `ResearchSource[]` snapshots via `onProgress`.
 */
export async function runResearchPipeline(opts: {
  messages: ModelMessage[];
  query: string;
  effort: EffortConfig;
  stages: { planner: StageRunner; summary: StageRunner };
  onProgress?: (progress: {
    steps: ResearchStepData[];
    sources: ResearchSource[];
  }) => void | Promise<void>;
  signal?: AbortSignal;
  requestId: string;
  deps?: Partial<ResearchDeps>;
}): Promise<ResearchOutcome> {
  const { messages, query, effort, signal, requestId } = opts;
  const {
    resultsPerQuery,
    deepResultsPerQuery,
    sourcesPerRound,
    deepSourcesPerRound,
    maxSources,
  } = serverConfig.research;

  if (effort.rounds === 0 || !query.trim()) {
    return {
      searched: false,
      evidenceBlock: "",
      totalSources: 0,
      sources: [],
      steps: [],
    };
  }

  const isDeep = effort.deep;
  const planner = opts.deps?.planner ?? createTextPlanner(opts.stages.planner);
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
  };

  const roundResultsPerQuery = isDeep ? deepResultsPerQuery : resultsPerQuery;
  const perRoundCap = isDeep ? deepSourcesPerRound : sourcesPerRound;
  const evidenceBudget = isDeep
    ? serverConfig.synthesis.deepEvidenceTokenBudget
    : serverConfig.synthesis.evidenceTokenBudget;

  const explicitUrls = extractUrls(query).slice(0, MAX_EXPLICIT_URLS);
  const seenUrlKeys = new Set<string>();
  const allNotes: string[] = [];
  const allSources: ResearchSource[] = [];
  const stepsByRound = new Map<number, ResearchStepData>();
  let totalSources = 0;

  let failedQueryCount = 0;
  let failedContents = false;
  let fallbackSources = 0;
  const failedStages: string[] = [];

  const currentDegraded = (): DegradedResearch | undefined => {
    const reasons: string[] = [];
    if (failedQueryCount > 0) {
      reasons.push(
        `${failedQueryCount} search ${failedQueryCount === 1 ? "query" : "queries"} failed`,
      );
    }
    if (failedContents) {
      reasons.push("one or more explicit URLs could not be fetched");
    }
    if (fallbackSources > 0) {
      reasons.push(
        `${fallbackSources} ${fallbackSources === 1 ? "source" : "sources"} could only be partially read`,
      );
    }
    reasons.push(...failedStages);
    return reasons.length > 0 ? reasons : undefined;
  };

  const currentSteps = () =>
    [...stepsByRound.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, step]) => step);

  const emitStep = async (data: ResearchStepData) => {
    stepsByRound.set(data.round, data);
    await opts.onProgress?.({
      steps: currentSteps(),
      sources: [...allSources],
    });
  };

  // --- Round 1: Plan initial search query ---
  await emitStep({ round: 1, phase: "planning", sources: [] });

  let initialQuery = "";
  let effectiveQuery = query;
  let skipSearch = false;
  try {
    const parsed = await planner.planQuery({ messages, signal, requestId });
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
    stepsByRound.clear();
    await opts.onProgress?.({ steps: [], sources: [] });
    return {
      searched: false,
      evidenceBlock: "",
      totalSources: 0,
      sources: [],
      steps: [],
    };
  }

  // --- Strictly sequential single-search rounds ---
  const allQueries: string[] = [];
  let currentQuery = initialQuery;

  for (let round = 1; round <= effort.rounds; round++) {
    allQueries.push(currentQuery);
    await emitStep({ round, phase: "searching", query: currentQuery, sources: [] });

    const directOutcome =
      round === 1 && explicitUrls.length > 0
        ? await search.fetchContents(explicitUrls, {
            signal,
            requestId,
            highlightsQuery: effectiveQuery,
          })
        : { docs: [] as ExaDocument[] };
    const searchOutcome = await search.search(currentQuery, roundResultsPerQuery, {
      signal,
      requestId,
      highlightsQuery: effectiveQuery,
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

    const roundCap = Math.min(perRoundCap, maxSources - totalSources);
    const roundDocs = selectDeduplicatedDocs(
      directOutcome.docs,
      searchOutcome.docs,
      seenUrlKeys,
      roundCap,
    );

    if (roundDocs.length === 0) {
      if (round === 1) {
        await emitStep({
          round,
          phase: "error",
          query: currentQuery,
          sources: [],
          error: "No web sources could be retrieved for this query.",
          degraded: currentDegraded(),
        });
        return {
          searched: false,
          searchFailed: true,
          evidenceBlock: "",
          totalSources: 0,
          sources: [],
          steps: currentSteps(),
          degraded: currentDegraded(),
        };
      }
      await emitStep({
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
    await emitStep({ round, phase: "reading", query: currentQuery, sources: roundSources });

    const condensed = await condenser.condense(roundDocs, {
      query: effectiveQuery,
      batchSize: isDeep ? serverConfig.summary.deepBatchSize : undefined,
      perSourceCharCap: isDeep
        ? serverConfig.summary.deepPerSourceInputCharCap
        : undefined,
      signal,
      requestId,
    });
    fallbackSources += condensed.fallbackCount;
    allNotes.push(...condensed.notes);
    totalSources += roundDocs.length;
    const notesText = condensed.notes.join("\n\n");

    const gatherFull = estimateTokens(allNotes.join("\n\n")) >= evidenceBudget;
    const isLastRound = round >= effort.rounds || totalSources >= maxSources || gatherFull;
    if (isLastRound) {
      await emitStep({
        round,
        phase: "done",
        query: currentQuery,
        sources: roundSources,
        notes: notesText,
        degraded: currentDegraded(),
      });
      break;
    }

    await emitStep({
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
      const parsedGap = await planner.planFollowUp({
        query: effectiveQuery,
        priorQueries: allQueries,
        notes: gapNotes,
        effortLevel: effort.level,
        signal,
        requestId,
      });
      if (
        !parsedGap.stopped &&
        parsedGap.query &&
        !priorLower.has(parsedGap.query.toLowerCase())
      ) {
        nextFollowUp = parsedGap.query;
      }
    } catch (error) {
      if (isAbortError(error) || signal?.aborted) throw error;
      logError("gap-check", error, { requestId });
      if (!failedStages.includes("the gap check could not be completed")) {
        failedStages.push("the gap check could not be completed");
      }
    }

    await emitStep({
      round,
      phase: "done",
      query: currentQuery,
      sources: roundSources,
      notes: notesText,
      degraded: currentDegraded(),
    });
    logDebug("gap-check", { requestId, round, followUpQuery: nextFollowUp });

    if (!nextFollowUp) break;
    currentQuery = nextFollowUp;
  }

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

  return {
    searched: true,
    evidenceBlock: budgeted.text,
    totalSources,
    sources: allSources,
    steps: currentSteps(),
    degraded: currentDegraded(),
  };
}
