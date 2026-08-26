import { stopChatStream, isChatId } from "@/lib/agent/in-memory-stream";

/**
 * Cancel generation for this chat. Client disconnect is *not* a stop; only
 * this endpoint (the Stop button) should abort the agent.
 */
export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  if (!isChatId(id)) {
    return Response.json({ ok: false }, { status: 400 });
  }
  stopChatStream(id);
  return Response.json({ ok: true });
}
