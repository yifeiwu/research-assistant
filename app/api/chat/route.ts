import { convertToModelMessages, streamText, type UIMessage } from "ai";
import type { GroqProviderOptions } from "@ai-sdk/groq";
import { after } from "next/server";
import { effortConfig } from "@/lib/effort";
import { chatRequestSchema } from "@/lib/types/chat";
import { latestUserText, pruneToolHistory } from "@/lib/messages";
import { buildDirectAnswerPrompt, buildSynthesisPrompt } from "@/lib/prompts";
import { logInfo, logError } from "@/lib/logger";
import { resolveModels, isResolutionError } from "@/lib/agent/models";
import { createPipelineStreamResponse } from "@/lib/agent/stream";
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

  const { model, provider, effort: rawEffort, id: rawChatId } = parsed.data;
  const messages = parsed.data.messages as unknown as UIMessage[];
  const chatId = rawChatId && isChatId(rawChatId) ? rawChatId : undefined;

  const effort = effortConfig(rawEffort);
  if (effort.rounds > 0 && !process.env.EXA_API_KEY?.trim()) {
    return Response.json(
      { error: "EXA_API_KEY is not set on the server." },
      { status: 500 },
    );
  }

  const resolved = resolveModels({ model, provider });
  if (isResolutionError(resolved)) {
    return Response.json(
      { error: resolved.error },
      { status: resolved.status },
    );
  }
  const { mainModel, summaryModel, modelInfo, supportsReasoning } = resolved;

  const requestId = crypto.randomUUID().slice(0, 8);
  const query = latestUserText(messages);
  const turnId = latestUserMessageId(messages);

  // Convert messages BEFORE registering the Redis stream so malformed message
  // payloads fail cleanly with 400 rather than leaving an empty active run.
  let modelMessages: Awaited<ReturnType<typeof convertToModelMessages>>;
  try {
    modelMessages = await convertToModelMessages(pruneToolHistory(messages));
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

  try {
    return createPipelineStreamResponse(
      async (writer) => {
        if (signal?.aborted) {
          throw new DOMException("The operation was aborted.", "AbortError");
        }

        const outcome = await runResearchPipeline({
          messages: modelMessages,
          query,
          effort,
          mainModel,
          summaryModel,
          supportsReasoning,
          writer,
          signal,
          requestId,
        });

        const system = outcome.searched
          ? buildSynthesisPrompt(outcome.evidenceBlock)
          : buildDirectAnswerPrompt();

        return streamText({
          model: mainModel,
          system,
          messages: modelMessages,
          providerOptions: supportsReasoning
            ? {
                groq: {
                  reasoningFormat: "parsed",
                } satisfies GroqProviderOptions,
              }
            : undefined,
          timeout: { totalMs: 180_000, stepMs: 120_000 },
          abortSignal: signal,
          onAbort: () => {
            logInfo("abort", { requestId, model: modelInfo });
          },
          onError: ({ error }) => {
            logError("streamText", error, { requestId, model: modelInfo });
          },
          onFinish: ({ finishReason, usage }) => {
            logInfo("finish", {
              requestId,
              finishReason,
              searched: outcome.searched,
              sources: outcome.totalSources,
              usage,
            });
          },
        });
      },
      { requestId, modelInfo, signal },
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
