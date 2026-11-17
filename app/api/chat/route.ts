import { after } from "next/server";
import { serverConfig } from "@/lib/config";
import { effortConfig } from "@/lib/effort";
import { isAbortError } from "@/lib/errors";
import {
  chatRequestSchema,
  type ResearchSource,
  type ResearchStepData,
} from "@/lib/types/chat";
import {
  collectPriorSources,
  findLastUserMessageId,
  latestUserText,
  toModelMessages,
} from "@/lib/messages";
import { logError, logInfo } from "@/lib/logger";
import { isResolutionError, planModels } from "@/lib/agent/models";
import { sharedRequestQueue } from "@/lib/agent/queue";
import { clientErrorMessage, executeTurn } from "@/lib/agent/turn";
import {
  finishDurableTurn,
  isTurnCancelled,
  startDurableTurn,
  updateDurableTurnProgress,
  updateDurableTurnWait,
  watchDurableTurn,
} from "@/lib/agent/turn-store";
import { checkChatRateLimit, getClientIp } from "@/lib/rate-limit";

export const maxDuration = 300;

const QUEUE_FULL_RETRY_AFTER_SECONDS = 15;

export async function POST(req: Request) {
  const startedAt = Date.now();

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

  const { messages, effort: rawEffort, id: rawChatId } = parsed.data;
  const chatId = rawChatId ?? crypto.randomUUID();
  const effort = effortConfig(rawEffort);

  if (effort.rounds > 0 && !process.env.EXA_API_KEY?.trim()) {
    return Response.json(
      { error: "EXA_API_KEY is not set on the server." },
      { status: 500 },
    );
  }

  const plan = planModels();
  if (isResolutionError(plan)) {
    return Response.json({ error: plan.error }, { status: plan.status });
  }

  const queue = sharedRequestQueue();
  if (await queue.isFull()) {
    return Response.json(
      {
        error:
          "The server is busy with other requests right now. Please try again in a moment.",
      },
      {
        status: 429,
        headers: { "Retry-After": String(QUEUE_FULL_RETRY_AFTER_SECONDS) },
      },
    );
  }

  const requestId = crypto.randomUUID().slice(0, 8);
  const query = latestUserText(messages);
  const turnId = findLastUserMessageId(messages);
  const modelMessages = toModelMessages(
    messages,
    serverConfig.synthesis.historyTokenBudget,
  );
  const priorSources = collectPriorSources(messages);

  logInfo("request", {
    requestId,
    chatId,
    reasoningPool: plan.pools.reasoning,
    summarizerPool: plan.pools.summarizer,
    messageCount: messages.length,
    query: query.slice(0, 200),
    effort: effort.level,
    rounds: effort.rounds,
  });

  let started: Awaited<ReturnType<typeof startDurableTurn>>;
  try {
    started = await startDurableTurn(chatId, turnId);
  } catch (error) {
    logError("turn-start", error, { requestId, chatId });
    return Response.json(
      {
        error:
          "Couldn't initialize the turn store. Check that Upstash Redis environment variables are set.",
      },
      { status: 500 },
    );
  }

  if (started.preStopped) {
    return Response.json(started.state, { status: 200 });
  }

  const { runId } = started.state;
  const deadlineAt =
    startedAt +
    serverConfig.turn.invocationLimitMs -
    serverConfig.turn.finishMarginMs;

  after(async () => {
    const abortController = new AbortController();
    const stopWatching = watchDurableTurn(chatId, runId, abortController, { turnId });
    let releaseQueue: (() => Promise<void>) | undefined;
    let latestSteps: ResearchStepData[] = [];
    let latestSources: ResearchSource[] = [];

    try {
      releaseQueue = await queue.acquire(runId, {
        signal: abortController.signal,
        deadlineAt,
        onPosition: (pos) =>
          updateDurableTurnWait(
            runId,
            pos != null ? { kind: "queued", position: pos } : null,
          ),
      });

      const outcome = await executeTurn({
        requestId,
        query,
        effort,
        modelMessages,
        priorSources,
        signal: abortController.signal,
        deadlineAt,
        onProgress: async (progress) => {
          latestSteps = progress.steps;
          latestSources = progress.sources;
          if (await isTurnCancelled(chatId, runId, undefined, turnId)) {
            abortController.abort();
            return;
          }
          await updateDurableTurnProgress(runId, progress);
        },
        onWait: (wait) => updateDurableTurnWait(runId, wait),
      });

      if (isResolutionError(outcome)) {
        await finishDurableTurn(
          chatId,
          runId,
          {
            status: "error",
            error: outcome.error,
            steps: latestSteps,
            sources: latestSources,
          },
          { turnId },
        );
        return;
      }

      await finishDurableTurn(
        chatId,
        runId,
        {
          status: "done",
          message: outcome.message,
          steps: outcome.steps,
          sources: outcome.sources,
        },
        { turnId },
      );
    } catch (error) {
      if (isAbortError(error) || abortController.signal.aborted) {
        await finishDurableTurn(
          chatId,
          runId,
          { status: "stopped", steps: latestSteps, sources: latestSources },
          { turnId },
        );
        return;
      }
      logError("turn-execute", error, { requestId, chatId, runId });
      await finishDurableTurn(
        chatId,
        runId,
        {
          status: "error",
          error: clientErrorMessage(error, requestId),
          steps: latestSteps,
          sources: latestSources,
        },
        { turnId },
      );
    } finally {
      stopWatching();
      await releaseQueue?.();
    }
  });

  return Response.json(started.state, { status: 202 });
}
