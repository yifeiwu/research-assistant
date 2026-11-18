import { isChatId, readDurableTurn } from "@/lib/agent/turn-store";

export const dynamic = "force-dynamic";

/**
 * Poll the durable turn state for `chatId` (addressed directly by `?runId=`
 * when supplied) in Upstash Redis.
 * Returns `204` when no turn is stored, or `200` JSON with `DurableTurnState`.
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  if (!isChatId(id)) {
    return new Response(null, { status: 204 });
  }

  const runId = new URL(req.url).searchParams.get("runId") ?? undefined;
  const state = await readDurableTurn(id, runId);
  if (!state) {
    return new Response(null, { status: 204 });
  }
  return Response.json(state);
}
