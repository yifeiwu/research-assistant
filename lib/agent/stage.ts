import "server-only";
import {
  generateText,
  type LanguageModel,
  type ModelMessage,
} from "ai";
import { createAbortError } from "@/lib/errors";
import { groqReasoningOptions } from "@/lib/models";
import { estimateTokens } from "@/lib/tokens";

export type StageLease = {
  model: LanguageModel;
  modelId: string;
};

export type StageLeaseRequest = {
  estInputTokens?: number | ((modelId: string) => number);
  maxOutputTokens?: number | ((modelId: string) => number);
  signal?: AbortSignal;
};

/**
 * A pipeline stage's handle on its fungible model pool: reserves per-minute
 * tokens and waits patiently if the pool's rolling window is full.
 */
export type StageRunner = {
  lease(req?: StageLeaseRequest): Promise<StageLease>;
};

/**
 * Lease tokens from `stage` and execute a non-retried auxiliary `generateText`
 * call with role-appropriate Groq reasoning settings and timeout.
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

  const leased = await req.stage.lease({
    estInputTokens,
    maxOutputTokens: req.maxOutputTokens,
    signal: req.signal,
  });
  const resolvedPrompt =
    typeof promptArg === "function"
      ? promptArg(leased.modelId)
      : (promptArg ?? "");
  const maxOut =
    typeof req.maxOutputTokens === "function"
      ? req.maxOutputTokens(leased.modelId)
      : req.maxOutputTokens;
  const run = req.generateTextImpl ?? generateText;
  const { text } = await run({
    model: leased.model,
    system: req.system,
    ...(req.messages ? { messages: req.messages } : { prompt: resolvedPrompt }),
    maxOutputTokens: maxOut,
    providerOptions: groqReasoningOptions(leased.modelId, "auxiliary"),
    ...(req.signal ? { abortSignal: req.signal } : {}),
    timeout: { totalMs: req.timeoutMs },
    maxRetries: 0,
  });
  return text;
}
