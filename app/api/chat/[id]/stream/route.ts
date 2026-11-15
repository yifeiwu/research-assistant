import { after } from "next/server";
import { activeChatRun, isChatId } from "@/lib/agent/chat-stream";
import { tailDetachedTurn } from "@/lib/agent/detached";

// Besides tailing, this request may run the turn itself, after (and
// regardless of) the response; see lib/agent/detached.ts.
export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * Reconnect to an in-flight (or recently finished) generation in Upstash Redis.
 * `useChat().resumeStream()` GETs `/api/chat/:id/stream`.
 * Background pending-thread polling GETs `/api/chat/:id/stream?onlyDone=1`.
 *
 * Either request also takes over an unfinished turn that no invocation is
 * running any more, and continues it.
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const startedAt = Date.now();
  const { id } = await ctx.params;
  if (!isChatId(id)) {
    return new Response(null, { status: 204 });
  }
  const url = new URL(req.url);
  const onlyDone = url.searchParams.get("onlyDone") === "1";

  const runId = await activeChatRun(id);
  const response = runId
    ? await tailDetachedTurn({
        chatId: id,
        runId,
        origin: onlyDone ? "poll" : "resume",
        startedAt,
        signal: req.signal,
        keepAlive: after,
      })
    : null;
  return response ?? new Response(null, { status: 204 });
}
