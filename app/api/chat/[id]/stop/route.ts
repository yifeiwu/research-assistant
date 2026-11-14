import { stopChatStream, isChatId, isTurnId } from "@/lib/agent/chat-stream";

/**
 * Cancel generation for this chat across serverless instances via Upstash Redis.
 * Client disconnect is *not* a stop; only this endpoint (the Stop button or
 * thread deletion) should abort server-side generation.
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  if (!isChatId(id)) {
    return Response.json({ ok: false }, { status: 400 });
  }

  let turnId: string | undefined;
  try {
    const body = (await req.json()) as { turnId?: unknown };
    if (isTurnId(body?.turnId)) {
      turnId = body.turnId;
    }
  } catch {
    // Empty body is valid.
  }

  await stopChatStream(id, turnId);
  return Response.json({ ok: true });
}
