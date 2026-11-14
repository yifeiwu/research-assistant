import "server-only";
import type { ModelMessage } from "ai";
import type { ExaDocument } from "./exa";
import type { DegradedResearch } from "./types/chat";

export type PortContext = { signal?: AbortSignal; requestId?: string };

/** Plans search queries (Round 1) and follow-up queries (gap check). */
export interface Planner {
  planQueries(input: {
    messages: ModelMessage[];
    maxQueries: number;
  } & PortContext): Promise<{ stopped: boolean; queries: string[] }>;
  planFollowUps(input: {
    query: string;
    priorQueries: string[];
    notes: string;
    maxQueries: number;
  } & PortContext): Promise<{ stopped: boolean; queries: string[] }>;
}

export type SearchOutcome = { docs: ExaDocument[]; error?: string };

/** Retrieves web documents. Failures are reported, never thrown (except abort). */
export interface SearchProvider {
  search(query: string, numResults: number, ctx: PortContext): Promise<SearchOutcome>;
  fetchContents(urls: string[], ctx: PortContext): Promise<SearchOutcome>;
}

export type CondenseOutcome = { notes: string[]; fallbackCount: number };

/** Condenses retrieved documents into research notes. */
export interface Condenser {
  condense(
    docs: ExaDocument[],
    input: { query: string } & PortContext,
  ): Promise<CondenseOutcome>;
}

/** Streams the final synthesised answer. Implemented by the chat route. */
export interface Synthesizer {
  synthesize(input: {
    evidenceBlock: string;
    degraded?: DegradedResearch;
    searched: boolean;
    searchFailed?: boolean;
  }): unknown;
}

export type ResearchDeps = {
  planner: Planner;
  search: SearchProvider;
  condenser: Condenser;
};