import { describe, expect, it } from "vitest";
import { failIfUnfinished } from "@/lib/unfinished-stream";

const SSE_HEADERS = { "content-type": "text/event-stream" };
const FINISH = 'data: {"type":"finish"}\n\n';
const DONE = "data: [DONE]\n\n";

/** A streamed response whose body arrives in the given pieces. */
function streamed(pieces: string[], headers: Record<string, string> = SSE_HEADERS): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const piece of pieces) controller.enqueue(encoder.encode(piece));
      controller.close();
    },
  });
  return new Response(body, { headers });
}

describe("failIfUnfinished", () => {
  it("passes a stream that ends with the closing frame through unchanged", async () => {
    let unfinished = false;
    // The closing frame may be split across network chunks.
    const response = failIfUnfinished(
      streamed(['data: {"type":"start"}\n\n', FINISH + "data: [DO", "NE]\n\n"]),
      () => {
        unfinished = true;
      },
    );
    expect(await response.text()).toBe(`data: {"type":"start"}\n\n${FINISH}${DONE}`);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(unfinished).toBe(false);
  });

  it("fails a stream that ends before the turn did, as a dropped connection would", async () => {
    let unfinished = false;
    const response = failIfUnfinished(
      // Text that merely mentions the frame is not the frame.
      streamed(['data: {"type":"text-delta","id":"t1","delta":"ends with data: [DONE]"}\n\n']),
      () => {
        unfinished = true;
      },
    );
    const error = await response.text().catch((e: unknown) => e);
    // What the AI SDK and the page both check for to treat it as a disconnect.
    expect(error).toBeInstanceOf(TypeError);
    expect((error as TypeError).message).toMatch(/network/);
    expect(unfinished).toBe(true);

    // An empty stream is unfinished too.
    await expect(failIfUnfinished(streamed([])).text()).rejects.toBeInstanceOf(TypeError);
  });

  it("leaves responses that are not a turn's stream alone", async () => {
    const rejected = Response.json({ error: "busy" }, { status: 429 });
    expect(failIfUnfinished(rejected)).toBe(rejected);

    const empty = new Response(null, { status: 204 });
    expect(failIfUnfinished(empty)).toBe(empty);

    const json = streamed(['{"ok":true}'], { "content-type": "application/json" });
    expect(failIfUnfinished(json)).toBe(json);
  });
});
