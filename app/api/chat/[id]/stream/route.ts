import { resumeChatStream, isChatId } from "@/lib/agent/chat-stream";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * Reconnect to an in-flight (or recently finished) generation in Upstash Redis.
 * `useChat().resumeStream()` GETs `/api/chat/:id/stream`.
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  if (!isChatId(id)) {
    return new Response(null, { status: 204 });
  }
  return (
    (await resumeChatStream(id, req.signal)) ??
    new Response(null, { status: 204 })
  );
}
