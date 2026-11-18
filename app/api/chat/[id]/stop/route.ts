import {
  isChatId,
  isRunId,
  stopDurableTurn,
} from "@/lib/agent/turn-store";

/**
 * Cancel an active turn for `chatId` across serverless instances via Upstash Redis.
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  if (!isChatId(id)) {
    return Response.json({ ok: false }, { status: 400 });
  }

  let runId: string | undefined;
  try {
    const body = (await req.json()) as { runId?: unknown };
    if (isRunId(body?.runId)) {
      runId = body.runId;
    }
  } catch {
    // Empty body is valid.
  }

  await stopDurableTurn(id, runId);
  return Response.json({ ok: true });
}
