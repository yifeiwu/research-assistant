import { convertToModelMessages, UI_MESSAGE_STREAM_HEADERS, type UIMessage } from "ai";
import { after } from "next/server";
import { effortConfig } from "@/lib/effort";
import { chatRequestSchema } from "@/lib/types/chat";
import { latestUserText, pruneAssistantHistory } from "@/lib/messages";
import { logInfo, logError } from "@/lib/logger";
import { isResolutionError, planModels } from "@/lib/agent/models";
import { checkChatRateLimit, getClientIp } from "@/lib/rate-limit";
import {
  sharedAdmissionQueue,
  type AdmissionTicket,
} from "@/lib/agent/admission";
import {
  startChatStream,
  abortChatStream,
  isChatId,
} from "@/lib/agent/chat-stream";
import {
  discardDetachedTurn,
  saveDetachedTurn,
  tailDetachedTurn,
} from "@/lib/agent/detached";

// The response relays the turn's output from Redis, and the turn itself runs
// in this invocation after (and regardless of) the response, both for at
// most this long. A turn that needs longer is continued by a later request;
// see lib/agent/detached.ts. `detached.invocationLimitMs` in lib/config.ts
// has to say the same (tests/config.test.ts checks).
export const maxDuration = 300;

/** How soon a client should retry after the research queue was full. */
const QUEUE_FULL_RETRY_AFTER_SECONDS = 15;

function latestUserMessageId(messages: UIMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user" && typeof messages[i].id === "string") {
      return messages[i].id;
    }
  }
  return undefined;
}

/** What a turn that was stopped before it produced anything streams back. */
function stoppedResponse(): Response {
  return new Response(
    'data: {"type":"start"}\n\ndata: {"type":"abort"}\n\ndata: [DONE]\n\n',
    { headers: UI_MESSAGE_STREAM_HEADERS },
  );
}

export async function POST(req: Request) {
  const startedAt = Date.now();

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
  // The run buffer is keyed by chat, so a request without a usable chat id
  // gets one of its own.
  const chatId = rawChatId && isChatId(rawChatId) ? rawChatId : crypto.randomUUID();

  const effort = effortConfig(rawEffort);
  if (effort.rounds > 0 && !process.env.EXA_API_KEY?.trim()) {
    return Response.json(
      { error: "EXA_API_KEY is not set on the server." },
      { status: 500 },
    );
  }

  const requestId = crypto.randomUUID().slice(0, 8);

  // Only to reject a misconfigured server up front and to log the choice;
  // each attempt builds the models it actually uses.
  const plan = planModels({ model });
  if (isResolutionError(plan)) {
    return Response.json({ error: plan.error }, { status: plan.status });
  }

  const query = latestUserText(messages);
  const turnId = latestUserMessageId(messages);
  const history = pruneAssistantHistory(messages);

  // Check the messages convert BEFORE registering the Redis stream, so a
  // malformed payload fails cleanly with 400 instead of in an attempt.
  try {
    await convertToModelMessages(history);
  } catch (error) {
    logError("convert-messages", error, { requestId, chatId });
    return Response.json(
      { error: "Could not process conversation messages." },
      { status: 400 },
    );
  }

  logInfo("request", {
    requestId,
    model: `groq ${plan.selectedModel}`,
    plannerModel: plan.candidates.planner[0],
    summaryModel: plan.candidates.summary[0],
    messageCount: messages.length,
    query: query.slice(0, 200),
    rounds: effort.rounds,
    followUpQueries: effort.followUpQueries,
  });

  // Research turns take a place in the shared FIFO queue. Join it before any
  // stream exists so a full queue is a plain 429 the client can retry.
  const queue = sharedAdmissionQueue();
  let ticket: AdmissionTicket | undefined;
  if (queue.enabled && effort.rounds > 0 && query.trim()) {
    ticket = {
      id: `${requestId}-${crypto.randomUUID().slice(0, 8)}`,
      enqueuedAt: startedAt,
    };
    const initial = await queue.poll(ticket);
    if (initial.state === "full") {
      logInfo("admission-full", { requestId, queueLength: initial.queueLength });
      return Response.json(
        {
          error:
            "The server is busy with other research requests right now. Please try again in a moment.",
        },
        {
          status: 429,
          headers: { "Retry-After": String(QUEUE_FULL_RETRY_AFTER_SECONDS) },
        },
      );
    }
  }
  const leaveQueue = async () => {
    if (ticket) await queue.cancel(ticket);
  };

  let run: Awaited<ReturnType<typeof startChatStream>>;
  try {
    run = await startChatStream(chatId, turnId);
  } catch (error) {
    logError("stream-start", error, { requestId, chatId });
    await leaveQueue();
    return Response.json(
      {
        error:
          "Couldn't initialize the chat stream store. Check that Upstash Redis environment variables are set.",
      },
      { status: 500 },
    );
  }
  const { runId } = run;

  // Stop was pressed before this request got here: the run is already over.
  if (run.preStopped) {
    await leaveQueue();
    return stoppedResponse();
  }

  // Save the turn, then serve this request from the run's stream buffer
  // while the turn runs behind it.
  try {
    await saveDetachedTurn({
      runId,
      chatId,
      requestId,
      model,
      effort: rawEffort,
      messages: history,
      query,
      ticket,
      createdAt: startedAt,
    });
    const tail = await tailDetachedTurn({
      chatId,
      runId,
      origin: "start",
      startedAt,
      signal: req.signal,
      keepAlive: after,
    });
    // Nothing to tail means the run ended (stopped) before producing output.
    return tail ?? stoppedResponse();
  } catch (error) {
    logError("turn-start", error, { requestId, chatId, runId });
    // Make sure no later request runs it after this one has reported failure.
    await discardDetachedTurn(runId);
    await abortChatStream(chatId, runId);
    await leaveQueue();
    return Response.json(
      { error: "Couldn't start your request. Please try again in a moment." },
      { status: 503 },
    );
  }
}
