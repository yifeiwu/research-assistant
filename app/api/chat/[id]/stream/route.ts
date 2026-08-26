import { resumeChatStream, isChatId } from "@/lib/agent/in-memory-stream";

/**
 * Reconnect to an in-flight (or recently finished) generation.
 * `useChat().resumeStream()` GETs `/api/chat/:id/stream`.
 */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  if (!isChatId(id)) {
    return new Response(null, { status: 204 });
  }
  return resumeChatStream(id) ?? new Response(null, { status: 204 });
}
