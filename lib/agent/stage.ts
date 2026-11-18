import "server-only";
import {
  generateText,
  type LanguageModel,
  type ModelMessage,
} from "ai";
import { createAbortError } from "@/lib/errors";
import { groqReasoningOptions } from "@/lib/models";
import { estimateTokens } from "@/lib/tokens";
import type { HeaderBag } from "./groq-rate-limit";

export type StageLease = {
  model: LanguageModel;
  modelId: string;
};

export type StageRunRequest<T> = {
  estInputTokens?: number | ((modelId: string) => number);
  maxOutputTokens?: number | ((modelId: string) => number);
  timeoutMs?: number;
  signal?: AbortSignal;
  execute: (
    lease: StageLease,
    attemptSignal: AbortSignal,
  ) => Promise<{
    value: T;
    headers?: HeaderBag;
  }>;
};

/**
 * A pipeline stage's unified runner over its fungible model pool: paces
 * rolling 60s token budgets, builds native per-model prompts/options, and
 * fails over cleanly across peers on 429s, retirements, context overflows, or timeouts.
 */
export type StageRunner = {
  run<T>(req: StageRunRequest<T>): Promise<{ value: T; modelId: string }>;
};

/**
 * Execute an auxiliary `generateText` call through `stage.run` with native
 * per-model prompt sizing, output caps, and Groq reasoning options.
 */
export async function generateAuxiliaryText(req: {
  stage: StageRunner;
  system: string;
  prompt?: string | ((modelId: string) => string);
  messages?: ModelMessage[];
  maxOutputTokens: number | ((modelId: string) => number);
  timeoutMs: number;
  signal?: AbortSignal;
  generateTextImpl?: typeof generateText;
}): Promise<string> {
  if (req.signal?.aborted) throw createAbortError();

  const sysTokens = estimateTokens(req.system);
  const msgTokens = req.messages
    ? estimateTokens(JSON.stringify(req.messages))
    : 0;
  const promptArg = req.prompt;
  const estInputTokens =
    typeof promptArg === "function"
      ? (modelId: string) => sysTokens + estimateTokens(promptArg(modelId))
      : sysTokens + (req.messages ? msgTokens : estimateTokens(promptArg ?? ""));

  const run = req.generateTextImpl ?? generateText;
  const { value } = await req.stage.run({
    estInputTokens,
    maxOutputTokens: req.maxOutputTokens,
    timeoutMs: req.timeoutMs,
    signal: req.signal,
    execute: async (leased, attemptSignal) => {
      const resolvedPrompt =
        typeof promptArg === "function"
          ? promptArg(leased.modelId)
          : (promptArg ?? "");
      const maxOut =
        typeof req.maxOutputTokens === "function"
          ? req.maxOutputTokens(leased.modelId)
          : req.maxOutputTokens;
      const res = await run({
        model: leased.model,
        system: req.system,
        ...(req.messages ? { messages: req.messages } : { prompt: resolvedPrompt }),
        maxOutputTokens: maxOut,
        providerOptions: groqReasoningOptions(leased.modelId, "auxiliary"),
        abortSignal: attemptSignal,
        maxRetries: 0,
      });
      return { value: res.text, headers: res.response?.headers };
    },
  });
  return value;
}
