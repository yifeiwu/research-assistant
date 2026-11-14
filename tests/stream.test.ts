import { describe, expect, it } from "vitest";
import { createPipelineStreamResponse, type StreamResult } from "@/lib/agent/stream";

function chunkStream(chunks: unknown[]): ReadableStream<unknown> {
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
}

async function runChunks(chunks: unknown[]): Promise<string> {
  const result = {
    toUIMessageStream: () => chunkStream(chunks),
    finishReason: Promise.resolve("stop"),
  } as unknown as StreamResult;
  const response = createPipelineStreamResponse(async () => result, {
    requestId: "test1234",
    modelInfo: "groq test",
    getAllowedSources: () => [{ url: "https://example.com/a" }],
  });
  return response.text();
}

const textChunks = (deltas: string[]) => [
  { type: "text-start", id: "t1" },
  ...deltas.map((delta) => ({ type: "text-delta", id: "t1", delta })),
  { type: "text-end", id: "t1" },
];

describe("createPipelineStreamResponse citation verification", () => {
  it("preserves URLs inside a fenced block split across flushes", async () => {
    const sse = await runChunks(
      textChunks([
        "Before\n```\n",
        "fetch('https://nope.example/x')\n",
        "```\n",
        "See https://example.com/a.\n",
      ]),
    );
    expect(sse).toContain("nope.example");
    expect(sse).toContain("https://example.com/a");
  });

  it("streams very long single lines instead of waiting for text-end", async () => {
    const longLine = `Start ${"word ".repeat(1_200)}https://example.com/a`;
    const sse = await runChunks(textChunks([longLine]));
    expect(sse).toContain("https://example.com/a");
    // Multiple text-delta frames prove the cap flush emitted mid-line.
    expect(sse.match(/text-delta/g)?.length).toBeGreaterThan(1);
  });

  it("strips invented citations in prose", async () => {
    const sse = await runChunks(
      textChunks(["Claim [Fake](https://evil.example/x) here.\n"]),
    );
    expect(sse).not.toContain("evil.example");
    expect(sse).toContain("Fake");
  });
});
