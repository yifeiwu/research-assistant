import {
  convertToModelMessages,
  streamText,
  type UIMessage,
  type UIMessageStreamWriter,
} from "ai";
import { after } from "next/server";
import { effortConfig } from "@/lib/effort";
import { chatRequestSchema, type ChatUIMessage } from "@/lib/types/chat";
import { latestUserText, pruneAssistantHistory } from "@/lib/messages";
import { buildDirectAnswerPrompt, buildSynthesisPrompt } from "@/lib/prompts";
import { logInfo, logError } from "@/lib/logger";
import { resolveModels, isResolutionError } from "@/lib/agent/models";
import {
  groqModelLabel,
  groqReasoningOptions,
  maxSynthesisOutputTokens,
} from "@/lib/models";
import { serverConfig } from "@/lib/config";
import type { Synthesizer } from "@/lib/ports";
import { createPipelineStreamResponse } from "@/lib/agent/stream";
import { checkChatRateLimit, getClientIp } from "@/lib/rate-limit";
import { runResearchPipeline } from "@/lib/research";
import {
  startChatStream,
  abortChatStream,
  ingestSseStream,
  isChatId,
  type ChatStreamHandle,
} from "@/lib/agent/chat-stream";

// Allow the multi-stage research + synthesis pipeline plenty of headroom.
// Vercel Functions on Fluid compute allow up to 300s on all plans, and
// active-CPU billing pauses while waiting on Exa / model I/O.
export const maxDuration = 300;

function latestUserMessageId(messages: UIMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user" && typeof messages[i].id === "string") {
      return messages[i].id;
    }
  }
  return undefined;
}

export async function POST(req: Request) {
  // Per-IP Redis rate limit before any expensive work (model/Exa calls).
  const rateLimit = await checkChatRateLimit(getClientIp(req.headers));
  if (!rateLimit.allowed) {
    return Response.json(
      { error: "You're sending messages too quickly. Please wait a moment and try again." },
      {
        status: 429,
        headers: { "Retry-After": String(rateLimit.retryAfterSeconds) },
      },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json(
      { error: "Request body must be JSON." },
      { status: 400 },
    );
  }

  const parsed = chatRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid request body.", details: parsed.error.issues },
      { status: 400 },
    );
  }

  const { model, effort: rawEffort, id: rawChatId } = parsed.data;
  const messages = parsed.data.messages as unknown as UIMessage[];
  const chatId = rawChatId && isChatId(rawChatId) ? rawChatId : undefined;

  const effort = effortConfig(rawEffort);
  if (effort.rounds > 0 && !process.env.EXA_API_KEY?.trim()) {
    return Response.json(
      { error: "EXA_API_KEY is not set on the server." },
      { status: 500 },
    );
  }

  const requestId = crypto.randomUUID().slice(0, 8);
  let activeWriter: UIMessageStreamWriter<ChatUIMessage> | undefined;
  let activeModelInfo = "";

  const resolved = resolveModels({
    model,
    onSynthesisFallback: (event) => {
      activeModelInfo = `groq ${event.to}`;
      activeWriter?.write({
        type: "data-model-fallback",
        id: `model-fallback-${requestId}`,
        data: {
          fromModel: event.from,
          toModel: event.to,
          fromLabel: groqModelLabel(event.from),
          toLabel: groqModelLabel(event.to),
        },
      });
    },
  });
  if (isResolutionError(resolved)) {
    return Response.json(
      { error: resolved.error },
      { status: resolved.status },
    );
  }
  const {
    selectedModel,
    mainModel,
    plannerModel,
    plannerModelId,
    summaryModel,
    summaryModelId,
    modelInfo,
  } = resolved;
  activeModelInfo = modelInfo;

  const query = latestUserText(messages);
  const turnId = latestUserMessageId(messages);

  // Convert messages BEFORE registering the Redis stream so malformed message
  // payloads fail cleanly with 400 rather than leaving an empty active run.
  let modelMessages: Awaited<ReturnType<typeof convertToModelMessages>>;
  try {
    modelMessages = await convertToModelMessages(pruneAssistantHistory(messages));
  } catch (error) {
    logError("convert-messages", error, { requestId, chatId });
    return Response.json(
      { error: "Could not process conversation messages." },
      { status: 400 },
    );
  }

  logInfo("request", {
    requestId,
    model: modelInfo,
    plannerModel: plannerModelId,
    summaryModel: summaryModelId,
    messageCount: messages.length,
    query: query.slice(0, 200),
    rounds: effort.rounds,
    maxSources: effort.maxSources,
  });

  let streamHandle: ChatStreamHandle | undefined;
  if (chatId) {
    try {
      streamHandle = await startChatStream(chatId, turnId);
    } catch (error) {
      logError("stream-start", error, { requestId, chatId });
      return Response.json(
        {
          error:
            "Couldn't initialize the chat stream store. Check that Upstash Redis environment variables are set.",
        },
        { status: 500 },
      );
    }
  }

  const signal = streamHandle?.abortSignal;
  let allowedSources: import("@/lib/types/chat").ResearchSource[] = [];

  try {
    return createPipelineStreamResponse(
      async (writer) => {
        activeWriter = writer;
        if (signal?.aborted) {
          throw new DOMException("The operation was aborted.", "AbortError");
        }

        const outcome = await runResearchPipeline({
          messages: modelMessages,
          query,
          effort,
          plannerModel,
          plannerModelId,
          summaryModel,
          summaryModelId,
          writer,
          signal,
          requestId,
        });

        allowedSources = outcome.sources;
        const synthesizer: Synthesizer = {
          synthesize: (input) =>
            streamText({
              model: mainModel,
              system: input.searched
                ? buildSynthesisPrompt(input.evidenceBlock, input.degraded)
                : buildDirectAnswerPrompt(input.degraded, input.searchFailed),
              messages: modelMessages,
              providerOptions: groqReasoningOptions(selectedModel, "synthesis"),
              // Bounded per-model output reservation (e.g. 900 on Qwen's 1k OTPM
              // bucket, 3,500 on GPT-OSS); retries/fallbacks are owned by
              // `createResilientGroqFetch` so AI SDK blind retries are disabled.
              maxOutputTokens: maxSynthesisOutputTokens(
                selectedModel,
                serverConfig.synthesis.maxOutputTokens,
              ),
              maxRetries: 0,
              timeout: {
                totalMs: serverConfig.synthesis.totalTimeoutMs,
                stepMs: serverConfig.synthesis.stepTimeoutMs,
              },
              abortSignal: signal,
              onAbort: () => {
                logInfo("abort", { requestId, model: activeModelInfo });
              },
              onError: ({ error }) => {
                logError("streamText", error, { requestId, model: activeModelInfo });
              },
              onFinish: ({ finishReason, usage }) => {
                logInfo("finish", {
                  requestId,
                  model: activeModelInfo,
                  finishReason,
                  searched: outcome.searched,
                  sources: outcome.totalSources,
                  usage,
                });
              },
            }),
        };
        return synthesizer.synthesize({
          evidenceBlock: outcome.evidenceBlock,
          degraded: outcome.degraded,
          searched: outcome.searched,
          searchFailed: outcome.searchFailed,
        }) as ReturnType<typeof streamText>;
      },
      {
        requestId,
        modelInfo: () => activeModelInfo,
        signal,
        getAllowedSources: () => allowedSources,
      },
      streamHandle
        ? {
            consumeSseStream: ({ stream }) => {
              const done = ingestSseStream(streamHandle, stream);
              after(() => done);
            },
          }
        : undefined,
    );
  } catch (error) {
    if (streamHandle) {
      await abortChatStream(streamHandle);
    }
    throw error;
  }
}
