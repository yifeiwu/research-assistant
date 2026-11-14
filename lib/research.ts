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
import { condenseSources, stripThinking } from "./pipeline";
import { buildGapCheckPrompt, buildQueryPlanPrompt } from "./prompts";
import { extractUrls, normalizeUrlKey } from "./sources";
import type {
  ChatUIMessage,
  ResearchSource,
  ResearchStepData,
} from "./types/chat";

const MAX_EXPLICIT_URLS = 4;
const MAX_QUERY_LENGTH = 240;

export type ResearchOutcome = {
  /** Whether any web evidence was gathered. */
  searched: boolean;
  /** Formatted research notes passed into the final synthesis prompt. */
  evidenceBlock: string;
  /** Total deduplicated sources condensed across all rounds. */
  totalSources: number;
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
  if (!cleaned) {
    return { stopped: false, lines: [] };
  }

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
    // Skip fenced code block markers or obvious conversational preambles.
    if (rawLine.startsWith("```")) continue;
    if (/^(here are|search queries|follow-up queries|queries)\b.*:$/i.test(rawLine)) {
      continue;
    }

    const normalized = rawLine
      // Strip leading bullets or numbering (`1.`, `1)`, `-`, `*`, `•`).
      .replace(/^(?:[-*•]+|\d+[.)])\s*/, "")
      // Strip wrapping quotes/backticks.
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
 * Interleave search results round-robin across queries (`q0[0], q1[0], ...,
 * q0[1], q1[1], ...`) while deduplicating against `seenUrlKeys` so every query
 * angle gets fair representation within `maxCount`.
 */
function selectDeduplicatedDocs(
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

  for (const doc of priorityDocs) {
    tryAdd(doc);
  }

  const maxDepth = queryResultBatches.reduce(
    (max, batch) => Math.max(max, batch.length),
    0,
  );
  for (let depth = 0; depth < maxDepth && selected.length < maxCount; depth++) {
    for (const batch of queryResultBatches) {
      if (depth < batch.length) {
        tryAdd(batch[depth]);
      }
    }
  }

  return selected;
}

function toResearchSource(doc: ExaDocument): ResearchSource {
  return {
    url: doc.url,
    title: doc.title,
    publishedDate: doc.publishedDate,
  };
}

/**
 * Execute the deterministic multi-stage research pipeline (Query Plan ->
 * Parallel Exa Retrieval -> Bounded Map Condensation -> Optional Gap Check &
 * Round 2), emitting live `data-research-step` and `source-url` UI stream
 * chunks along the way.
 */
export async function runResearchPipeline(opts: {
  messages: ModelMessage[];
  query: string;
  effort: EffortConfig;
  mainModel: LanguageModel;
  summaryModel: LanguageModel;
  supportsReasoning: boolean;
  writer: UIMessageStreamWriter<ChatUIMessage>;
  signal?: AbortSignal;
  requestId: string;
}): Promise<ResearchOutcome> {
  const {
    messages,
    query,
    effort,
    mainModel,
    summaryModel,
    supportsReasoning,
    writer,
    signal,
    requestId,
  } = opts;

  if (effort.rounds === 0 || !query.trim()) {
    return { searched: false, evidenceBlock: "", totalSources: 0 };
  }

  const reasoningOpts = supportsReasoning
    ? { groq: { reasoningFormat: "parsed" } satisfies GroqProviderOptions }
    : undefined;

  const exa = createExaClient({ signal, requestId });
  const explicitUrls = extractUrls(query).slice(0, MAX_EXPLICIT_URLS);
  const seenUrlKeys = new Set<string>();
  const allNotes: string[] = [];
  let totalSources = 0;

  const emitStep = (id: string, data: ResearchStepData) => {
    writer.write({
      type: "data-research-step",
      id,
      data,
    });
  };

  const emitSources = (docs: ExaDocument[]) => {
    for (const doc of docs) {
      writer.write({
        type: "source-url",
        sourceId: crypto.randomUUID(),
        url: doc.url,
        title: doc.title,
      });
    }
  };

  // --- Round 1: Plan queries ---
  const round1Id = `research-r1-${requestId}`;
  emitStep(round1Id, {
    round: 1,
    phase: "planning",
    queries: [],
    sources: [],
  });

  let round1Queries: string[] = [];
  let skipSearch = false;

  try {
    const planResult = await generateText({
      model: mainModel,
      system: buildQueryPlanPrompt(effort.queriesPerRound),
      messages,
      maxOutputTokens: 1_500,
      providerOptions: reasoningOpts,
      abortSignal: signal,
      timeout: { totalMs: 30_000 },
      maxRetries: 1,
    });

    const parsed = parsePlainTextLines(planResult.text, {
      stopToken: "NO_SEARCH",
      maxLines: effort.queriesPerRound,
    });

    if (parsed.stopped && explicitUrls.length === 0) {
      skipSearch = true;
    } else if (parsed.lines.length > 0) {
      round1Queries = parsed.lines;
    } else if (!parsed.stopped) {
      // Deterministic fallback: use the user's raw question directly.
      round1Queries = [query.slice(0, MAX_QUERY_LENGTH)];
    }
  } catch (error) {
    if (isAbortError(error) || signal?.aborted) throw error;
    logError("query-plan", error, { requestId });
    // Deterministic fallback on planner error/timeout.
    round1Queries = [query.slice(0, MAX_QUERY_LENGTH)];
  }

  logInfo("research-plan", {
    requestId,
    skipSearch,
    queries: round1Queries,
    explicitUrls: explicitUrls.length,
  });

  if (skipSearch) {
    // Collapse the planning step into an empty done state (rendered as null).
    emitStep(round1Id, {
      round: 1,
      phase: "done",
      queries: [],
      sources: [],
    });
    return { searched: false, evidenceBlock: "", totalSources: 0 };
  }

  // --- Round 1: Parallel Exa search + explicit URL fetch ---
  emitStep(round1Id, {
    round: 1,
    phase: "searching",
    queries: round1Queries,
    sources: [],
  });

  const [explicitDocs, ...searchBatches] = await Promise.all([
    explicitUrls.length > 0 ? exa.fetchContents(explicitUrls) : Promise.resolve([]),
    ...round1Queries.map((q) => exa.search(q, effort.resultsPerQuery)),
  ]);

  const round1Docs = selectDeduplicatedDocs(
    explicitDocs,
    searchBatches,
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
    });
    return { searched: false, evidenceBlock: "", totalSources: 0 };
  }

  const round1Sources = round1Docs.map(toResearchSource);
  emitSources(round1Docs);

  // --- Round 1: Map condense ---
  emitStep(round1Id, {
    round: 1,
    phase: "reading",
    queries: round1Queries,
    sources: round1Sources,
  });

  const round1Condensed = await condenseSources(round1Docs, {
    model: summaryModel,
    query,
    signal,
    requestId,
  });

  allNotes.push(...round1Condensed);
  totalSources += round1Docs.length;
  const round1NotesText = round1Condensed.join("\n\n");

  // --- Optional Round 2 (High effort): Gap Check + Follow-up retrieval ---
  const remainingBudget = effort.maxSources - totalSources;
  if (effort.rounds >= 2 && effort.followUpQueries > 0 && remainingBudget > 0) {
    emitStep(round1Id, {
      round: 1,
      phase: "checking-gaps",
      queries: round1Queries,
      sources: round1Sources,
      notes: round1NotesText,
    });

    let followUpQueries: string[] = [];
    try {
      const gapResult = await generateText({
        model: mainModel,
        system: buildGapCheckPrompt(effort.followUpQueries),
        maxOutputTokens: 1_500,
        providerOptions: reasoningOpts,
        abortSignal: signal,
        timeout: { totalMs: 25_000 },
        maxRetries: 1,
        prompt: `User question:\n${query}\n\nQueries already run:\n${round1Queries.map((q) => `- ${q}`).join("\n")}\n\nGathered research notes so far:\n${round1NotesText}\n\nDecide whether these notes are sufficient ("DONE") or list up to ${effort.followUpQueries} follow-up search queries (one per line).`,
      });

      const priorSet = new Set(round1Queries.map((q) => q.toLowerCase()));
      const parsedGap = parsePlainTextLines(gapResult.text, {
        stopToken: "DONE",
        maxLines: effort.followUpQueries,
      });

      if (!parsedGap.stopped) {
        followUpQueries = parsedGap.lines.filter(
          (q) => !priorSet.has(q.toLowerCase()),
        );
      }
    } catch (error) {
      if (isAbortError(error) || signal?.aborted) throw error;
      logError("gap-check", error, { requestId });
    }

    // Mark Round 1 complete before starting Round 2 (or synthesizing).
    emitStep(round1Id, {
      round: 1,
      phase: "done",
      queries: round1Queries,
      sources: round1Sources,
      notes: round1NotesText,
    });

    logDebug("gap-check", { requestId, followUpQueries });

    if (followUpQueries.length > 0) {
      const round2Id = `research-r2-${requestId}`;
      emitStep(round2Id, {
        round: 2,
        phase: "searching",
        queries: followUpQueries,
        sources: [],
      });

      const round2Batches = await Promise.all(
        followUpQueries.map((q) => exa.search(q, effort.resultsPerQuery)),
      );

      const round2Docs = selectDeduplicatedDocs(
        [],
        round2Batches,
        seenUrlKeys,
        remainingBudget,
      );

      if (round2Docs.length > 0) {
        const round2Sources = round2Docs.map(toResearchSource);
        emitSources(round2Docs);

        emitStep(round2Id, {
          round: 2,
          phase: "reading",
          queries: followUpQueries,
          sources: round2Sources,
        });

        const round2Condensed = await condenseSources(round2Docs, {
          model: summaryModel,
          query,
          signal,
          requestId,
        });

        allNotes.push(...round2Condensed);
        totalSources += round2Docs.length;

        emitStep(round2Id, {
          round: 2,
          phase: "done",
          queries: followUpQueries,
          sources: round2Sources,
          notes: round2Condensed.join("\n\n"),
        });
      } else {
        emitStep(round2Id, {
          round: 2,
          phase: "done",
          queries: followUpQueries,
          sources: [],
          notes: "_Follow-up queries did not surface any additional unseen sources._",
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
    });
  }

  const evidenceBlock = allNotes
    .map((note, idx) => `[Source ${idx + 1}]\n${note}`)
    .join("\n\n---\n\n");

  return {
    searched: true,
    evidenceBlock,
    totalSources,
  };
}
