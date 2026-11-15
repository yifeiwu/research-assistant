import "server-only";
import type { ModelMessage } from "ai";
import type { ExaDocument, ExaSearchRequestOptions } from "./exa";

export type PortContext = { signal?: AbortSignal; requestId?: string };

/** Plans the initial search query (Round 1), sequential follow-up queries (gap check), and optional source reranking. */
export interface Planner {
  planQuery(input: {
    messages: ModelMessage[];
    effortLevel?: import("./effort").EffortLevel;
  } & PortContext): Promise<{ stopped: boolean; brief?: string; query?: string }>;
  planFollowUp(input: {
    query: string;
    priorQueries: string[];
    notes: string;
    effortLevel?: import("./effort").EffortLevel;
    citedPrimaryQueries?: string[];
  } & PortContext): Promise<{ stopped: boolean; query?: string }>;
  rerankSources?(input: {
    query: string;
    candidates: ExaDocument[];
    maxSelect: number;
  } & PortContext): Promise<ExaDocument[]>;
}

export type SearchOutcome = { docs: ExaDocument[]; error?: string };

/** Retrieves web documents. Failures are reported, never thrown (except abort). */
export interface SearchProvider {
  search(
    query: string,
    numResults: number,
    ctx: PortContext & ExaSearchRequestOptions,
  ): Promise<SearchOutcome>;
  fetchContents(
    urls: string[],
    ctx: PortContext & { maxCharacters?: number },
  ): Promise<SearchOutcome>;
}

export type PrimaryReferences = {
  urls: string[];
  queries: string[];
};

export type CondenseOutcome = {
  notes: string[];
  fallbackCount: number;
  primaryRefs?: PrimaryReferences;
};

/** Condenses retrieved documents into research notes and optionally distills multi-round notes. */
export interface Condenser {
  condense(
    docs: ExaDocument[],
    input: {
      query: string;
      batchSize?: number;
      perSourceCharCap?: number;
      patientWait?: boolean;
      extractPrimaryRefs?: boolean;
    } & PortContext,
  ): Promise<CondenseOutcome>;
  reduceNotes?(
    notes: string[],
    input: {
      query: string;
      targetTokenBudget: number;
      patientWait?: boolean;
    } & PortContext,
  ): Promise<{ evidenceBlock: string; reduced: boolean }>;
}

export type ResearchDeps = {
  planner: Planner;
  search: SearchProvider;
  condenser: Condenser;
};