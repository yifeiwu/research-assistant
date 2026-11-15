import type { LanguageModel, streamText } from "ai";
import type { ResolvedModels, resolveModels } from "@/lib/agent/models";
import type { StageRunner } from "@/lib/agent/stage";
import type { startTurn } from "@/lib/agent/turn";
import type { ResearchOutcome, runResearchPipeline } from "@/lib/research";

export const SELECTED = "openai/gpt-oss-120b";
export const FALLBACK = "openai/gpt-oss-20b";
export const model = (id: string) => ({ modelId: id }) as unknown as LanguageModel;

export const OUTCOME: ResearchOutcome = {
  searched: true,
  evidenceBlock: "[1] Example evidence",
  totalSources: 1,
  sources: [{ url: "https://example.com/a" }],
};

type TurnDeps = NonNullable<Parameters<typeof startTurn>[0]["deps"]>;

/**
 * Stand-ins for everything a turn calls out to: model resolution, the
 * research pipeline and the answer stream. `synthesisLease` controls what the
 * scheduler says when the answer is about to start.
 */
export function fakeTurnDeps(opts?: {
  synthesisLease?: () => StageRunner["lease"] | undefined;
  /** Runs inside the fake research pipeline (e.g. to stop the turn mid-way). */
  onResearch?: (input: Parameters<typeof runResearchPipeline>[0]) => void | Promise<void>;
  /** Clock the turn reads; fixed unless given. */
  now?: () => number;
}) {
  const calls = {
    research: [] as Array<Parameters<typeof runResearchPipeline>[0]>,
    synthesis: [] as Array<Parameters<typeof streamText>[0]>,
  };
  let handlers: Parameters<typeof resolveModels>[0] | undefined;

  const runner = (id: string): StageRunner => ({
    primaryModelId: id,
    lease: async () => ({ model: model(id), modelId: id, waitedMs: 0 }),
  });
  const resolved: ResolvedModels = {
    selectedModel: SELECTED,
    mainModel: model(SELECTED),
    modelInfo: `groq ${SELECTED}`,
    stages: {
      synthesis: {
        primaryModelId: SELECTED,
        lease: (req) => (opts?.synthesisLease?.() ?? runner(SELECTED).lease)(req),
      },
      planner: runner("planner"),
      summary: runner("summary"),
    },
  };

  const deps: TurnDeps = {
    resolveModels: (input) => {
      handlers = input;
      return resolved;
    },
    runResearch: async (input) => {
      calls.research.push(input);
      await opts?.onResearch?.(input);
      // Like the real pipeline, show progress as a replaceable data part.
      input.writer.write({
        type: "data-research-step",
        id: `research-r1-${input.requestId}`,
        data: { round: 1, phase: "done", queries: ["q"], sources: OUTCOME.sources },
      });
      return OUTCOME;
    },
    streamText: ((input: Parameters<typeof streamText>[0]) => {
      calls.synthesis.push(input);
      return {
        toUIMessageStream: () =>
          new ReadableStream({
            start(controller) {
              controller.enqueue({ type: "text-start", id: "t1" });
              controller.enqueue({ type: "text-delta", id: "t1", delta: "Answer.\n" });
              controller.enqueue({ type: "text-end", id: "t1" });
              controller.close();
            },
          }),
        finishReason: Promise.resolve("stop"),
      };
    }) as unknown as typeof streamText,
    now: opts?.now ?? (() => 1_000),
  };

  return { deps, calls, resolved, handlers: () => handlers! };
}

/** Read a stream to its end. */
export async function readAll<T>(stream: ReadableStream<T>): Promise<T[]> {
  const items: T[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return items;
    items.push(value);
  }
}

/** Parse the JSON frames out of an SSE payload. */
export function sseEvents(sse: string): Array<Record<string, unknown>> {
  return sse
    .split("\n")
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
}
