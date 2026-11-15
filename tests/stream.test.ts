import React, { useEffect, useMemo, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { Chat } from "@ai-sdk/react";
import {
  APICallError,
  DefaultChatTransport,
  UI_MESSAGE_STREAM_HEADERS,
  type UIMessage,
} from "ai";
import { describe, expect, it } from "vitest";
import { AdmissionBusyError } from "@/lib/agent/admission";
import { createPipelineStream, type StreamResult } from "@/lib/agent/stream";
import { describeChatError } from "@/lib/chat-error";
import { CHAT_STREAM_THROTTLE_MS } from "@/lib/conversations";
import { useChatState } from "@/lib/hooks/useChatState";
import { readAll } from "./turn-fakes";

function chunkStream(chunks: unknown[]): ReadableStream<unknown> {
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
}

type Event = Record<string, unknown>;

/** What the pipeline stream emits for a model stream of `chunks`. */
async function runChunks(chunks: unknown[]): Promise<Event[]> {
  const result = {
    toUIMessageStream: () => chunkStream(chunks),
    finishReason: Promise.resolve("stop"),
  } as unknown as StreamResult;
  const { stream } = createPipelineStream(async () => result, {
    requestId: "test1234",
    modelInfo: "groq test",
    getAllowedSources: () => [{ url: "https://example.com/a" }],
    emitStart: true,
  });
  return (await readAll(stream)) as Event[];
}

/** All the text an event list would show, for substring checks. */
const textOf = (events: Event[]) => JSON.stringify(events);

const textChunks = (deltas: string[]) => [
  { type: "text-start", id: "t1" },
  ...deltas.map((delta) => ({ type: "text-delta", id: "t1", delta })),
  { type: "text-end", id: "t1" },
];

describe("createPipelineStream message identity", () => {
  it("opens the message with an id that is the same every time the turn is streamed", async () => {
    const first = await runChunks(textChunks(["Answer.\n"]));
    const again = await runChunks(textChunks(["Answer.\n"]));
    expect(first[0]).toMatchObject({ type: "start", messageId: expect.any(String) });
    // A client that reconnects rebuilds the message it already has.
    expect(again[0].messageId).toBe(first[0].messageId);
  });
});

describe("createPipelineStream citation verification", () => {
  it("preserves URLs inside a fenced block split across flushes", async () => {
    const text = textOf(
      await runChunks(
        textChunks([
          "Before\n```\n",
          "fetch('https://nope.example/x')\n",
          "```\n",
          "See https://example.com/a.\n",
        ]),
      ),
    );
    expect(text).toContain("nope.example");
    expect(text).toContain("https://example.com/a");
  });

  it("streams very long single lines instead of waiting for text-end", async () => {
    const longLine = `Start ${"word ".repeat(1_200)}https://example.com/a`;
    const events = await runChunks(textChunks([longLine]));
    expect(textOf(events)).toContain("https://example.com/a");
    // Multiple text-delta chunks prove the cap flush emitted mid-line.
    expect(events.filter((e) => e.type === "text-delta").length).toBeGreaterThan(1);
  });

  it("strips invented citations in prose", async () => {
    const text = textOf(
      await runChunks(textChunks(["Claim [Fake](https://evil.example/x) here.\n"])),
    );
    expect(text).not.toContain("evil.example");
    expect(text).toContain("Fake");
  });

  it("coalesces per-token reasoning-delta chunks without losing text or ordering", async () => {
    const tokens = Array.from({ length: 80 }, (_, i) => `t${i} `);
    const events = await runChunks([
      { type: "reasoning-start", id: "r1" },
      ...tokens.map((delta, i) => ({
        type: "reasoning-delta",
        id: "r1",
        delta,
        ...(i === 0 ? { providerMetadata: { groq: { step: 1 } } } : {}),
      })),
      { type: "reasoning-end", id: "r1" },
      ...textChunks(["Final answer.\n"]),
    ]);

    const reasoningDeltas = events.filter((e) => e.type === "reasoning-delta");
    expect(reasoningDeltas.length).toBeGreaterThan(0);
    expect(reasoningDeltas.length).toBeLessThan(10);
    expect(reasoningDeltas.map((e) => e.delta).join("")).toBe(tokens.join(""));
    expect(reasoningDeltas[0].providerMetadata).toEqual({ groq: { step: 1 } });

    const lastDeltaIdx = events.findLastIndex(
      (e) => e.type === "reasoning-delta",
    );
    const endIdx = events.findIndex((e) => e.type === "reasoning-end");
    expect(lastDeltaIdx).toBeLessThan(endIdx);
  });

  it("streams data-model-fallback parts and resolves dynamic modelInfo on error", async () => {
    let activeModel = "groq openai/gpt-oss-120b";
    const { stream, deferral } = createPipelineStream(
      async (writer) => {
        activeModel = "groq openai/gpt-oss-20b";
        writer.write({
          type: "data-model-fallback",
          id: "fb-1",
          data: {
            fromModel: "openai/gpt-oss-120b",
            toModel: "openai/gpt-oss-20b",
            fromLabel: "GPT-OSS 120B",
            toLabel: "GPT-OSS 20B",
          },
        });
        throw new Error("Rate limit reached for model `openai/gpt-oss-20b`.");
      },
      {
        requestId: "test1234",
        modelInfo: () => activeModel,
        emitStart: true,
      },
    );
    const text = textOf((await readAll(stream)) as Event[]);
    expect(text).toContain("data-model-fallback");
    expect(text).toContain("GPT-OSS 20B");
    expect(text).toContain("You've hit the rate limit for GPT-OSS 20B");
    // A failed turn is over, not handed back to the queue.
    expect(await deferral).toBeUndefined();
  });
});

describe("createPipelineStream error messages", () => {
  /** The error text a client is sent when the turn's work throws `error`. */
  async function errorTextFor(error: unknown): Promise<string> {
    const { stream } = createPipelineStream(
      async () => {
        throw error;
      },
      { requestId: "req12345", modelInfo: "groq openai/gpt-oss-120b", emitStart: true },
    );
    const events = (await readAll(stream)) as Event[];
    return String(events.find((e) => e.type === "error")?.errorText);
  }

  const SECRET = "org_01hxsecret";
  const providerError = (statusCode: number) =>
    new APICallError({
      message: `Provider said no to organization ${SECRET}`,
      url: "https://api.groq.com/openai/v1/chat/completions",
      requestBodyValues: {},
      statusCode,
      responseBody: JSON.stringify({ error: { message: `details for ${SECRET}` } }),
    });

  it("tells the user what kind of failure it was, in words the client can explain", async () => {
    const timeout = new Error("The operation was aborted due to timeout");
    timeout.name = "TimeoutError";
    const cases: Array<[unknown, string]> = [
      [providerError(401), "API key rejected"],
      [providerError(404), "Model not available"],
      [providerError(413), "Request too large for the model"],
      [providerError(503), "The server hit an error"],
      [providerError(429), "Model rate limit reached"],
      [timeout, "The request timed out"],
      [new AdmissionBusyError(), "The server is busy"],
      [providerError(400), "Something went wrong"],
      [new Error(`internal failure involving ${SECRET}`), "Something went wrong"],
    ];
    for (const [error, title] of cases) {
      const text = await errorTextFor(error);
      // What the page shows for it (lib/chat-error.ts).
      expect(describeChatError(new Error(text)).title).toBe(title);
    }
  });

  it("never passes an error's own text on, and gives a reference to the server log instead", async () => {
    for (const error of [
      providerError(400),
      providerError(401),
      providerError(500),
      new Error(`internal failure involving ${SECRET}`),
      `a thrown string naming ${SECRET}`,
    ]) {
      const text = await errorTextFor(error);
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain("Provider said");
    }
    expect(await errorTextFor(new Error("anything"))).toContain("reference req12345");
  });

  it("takes only the wait from a rate-limit message", async () => {
    const error = new APICallError({
      message: `Rate limit reached for model \`openai/gpt-oss-120b\` in organization ${SECRET} on tokens per minute (TPM): Limit 8000. Please try again in 7.66s. Need more tokens? Upgrade at https://console.groq.com/settings/billing`,
      url: "https://api.groq.com/openai/v1/chat/completions",
      requestBodyValues: {},
      statusCode: 429,
    });
    const text = await errorTextFor(error);
    expect(text).toContain("try again in about 7.66s");
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("console.groq.com");
  });
});

describe("useChatState React 19 streaming & polling protection (React #185)", () => {
  function installMinimalDom() {
    type MockNode = {
      nodeType: number;
      nodeName: string;
      tagName?: string;
      namespaceURI: string;
      childNodes: MockNode[];
      style: Record<string, unknown>;
      ownerDocument: unknown;
      nodeValue?: string;
      appendChild: (c: MockNode) => MockNode;
      removeChild: (c: MockNode) => MockNode;
      insertBefore: (c: MockNode) => MockNode;
      setAttribute: () => void;
      removeAttribute: () => void;
      addEventListener: () => void;
      removeEventListener: () => void;
    };

    const makeNode = (tag: string, owner: unknown): MockNode => ({
      nodeType: tag === "#text" ? 3 : 1,
      nodeName: tag.toUpperCase(),
      ...(tag === "#text" ? {} : { tagName: tag.toUpperCase() }),
      namespaceURI: "http://www.w3.org/1999/xhtml",
      childNodes: [],
      style: {},
      ownerDocument: owner,
      appendChild(c) {
        this.childNodes.push(c);
        return c;
      },
      removeChild(c) {
        this.childNodes = this.childNodes.filter((x) => x !== c);
        return c;
      },
      insertBefore(c) {
        this.childNodes.push(c);
        return c;
      },
      setAttribute() {},
      removeAttribute() {},
      addEventListener() {},
      removeEventListener() {},
    });

    const prevWindow = (globalThis as Record<string, unknown>).window;
    const prevDocument = (globalThis as Record<string, unknown>).document;
    const prevIframe = (globalThis as Record<string, unknown>).HTMLIFrameElement;

    (globalThis as Record<string, unknown>).HTMLIFrameElement = class {};
    const doc: Record<string, unknown> = {
      nodeType: 9,
      defaultView: globalThis,
      activeElement: null,
      addEventListener() {},
      removeEventListener() {},
    };
    doc.documentElement = makeNode("html", doc);
    doc.createElement = (t: string) => makeNode(t, doc);
    doc.createTextNode = (t: string) => {
      const n = makeNode("#text", doc);
      n.nodeValue = t;
      return n;
    };

    (globalThis as Record<string, unknown>).window = globalThis;
    (globalThis as Record<string, unknown>).document = doc;

    return {
      container: makeNode("div", doc) as unknown as Element,
      restore() {
        (globalThis as Record<string, unknown>).window = prevWindow;
        (globalThis as Record<string, unknown>).document = prevDocument;
        (globalThis as Record<string, unknown>).HTMLIFrameElement = prevIframe;
      },
    };
  }

  it("handles >150 back-to-back SSE chunks without hitting Maximum update depth exceeded (#185)", async () => {
    const dom = installMinimalDom();
    try {
      const frames = [
        `data: ${JSON.stringify({ type: "start", messageId: "a1" })}\n\n`,
        `data: ${JSON.stringify({ type: "reasoning-start", id: "r1" })}\n\n`,
        ...Array.from(
          { length: 100 },
          () =>
            `data: ${JSON.stringify({ type: "reasoning-delta", id: "r1", delta: "step " })}\n\n`,
        ),
        `data: ${JSON.stringify({ type: "reasoning-end", id: "r1" })}\n\n`,
        `data: ${JSON.stringify({ type: "text-start", id: "t1" })}\n\n`,
        ...Array.from(
          { length: 80 },
          () =>
            `data: ${JSON.stringify({ type: "text-delta", id: "t1", delta: "word " })}\n\n`,
        ),
        `data: ${JSON.stringify({ type: "text-end", id: "t1" })}\n\n`,
        `data: ${JSON.stringify({ type: "finish", finishReason: "stop" })}\n\n`,
        `data: [DONE]\n\n`,
      ];
      const payload = new TextEncoder().encode(frames.join(""));

      let observedError: Error | undefined;
      let chatInstance!: Chat<UIMessage>;
      let renderedText = "";

      function Harness() {
        const [chat] = useState(() => {
          const transport = new DefaultChatTransport({
            api: "/api/chat",
            fetch: async () =>
              new Response(
                new ReadableStream({
                  start(ctrl) {
                    ctrl.enqueue(payload);
                    ctrl.close();
                  },
                }),
                { headers: UI_MESSAGE_STREAM_HEADERS },
              ),
          });
          return new Chat({
            id: "chat_burst_test",
            transport,
            onError: (err) => {
              observedError = err;
            },
          });
        });
        chatInstance = chat;

        const { messages, status, error } = useChatState(
          chat,
          CHAT_STREAM_THROTTLE_MS,
        );
        const [saved, setSaved] = useState<string[]>([]);
        const isBusy = status === "submitted" || status === "streaming";

        // Mirrors the `DefaultLane` effect update on turn start that previously
        // armed React 19's `nestedUpdateCount` counter across unthrottled chunks.
        useEffect(() => {
          if (!isBusy || messages.length === 0) return;
          setSaved((prev) => (prev.length > 0 ? prev : ["chat_burst_test"]));
        }, [isBusy, messages]);

        const last = messages[messages.length - 1];
        const textPart = last?.parts.find((p) => p.type === "text") as
          | { type: "text"; text: string }
          | undefined;
        renderedText = textPart?.text ?? "";

        return React.createElement(
          "div",
          null,
          error ? error.message : `${saved.length}:${renderedText.length}`,
        );
      }

      const root = createRoot(dom.container);
      root.render(React.createElement(Harness));
      await new Promise((r) => setTimeout(r, 30));

      await chatInstance.sendMessage({
        text: "test burst",
      });
      await new Promise((r) => setTimeout(r, CHAT_STREAM_THROTTLE_MS * 2));

      expect(observedError).toBeUndefined();
      expect(chatInstance.error).toBeUndefined();
      expect(chatInstance.status).toBe("ready");
      expect(renderedText).toBe("word ".repeat(80));

      root.unmount();
      await new Promise((r) => setTimeout(r, 10));
    } finally {
      dom.restore();
    }
  });

  it("does not hit #185 when spaced SSE chunks (> throttle) interleave with timer/polling state updates", async () => {
    const dom = installMinimalDom();
    try {
      let observedError: Error | undefined;
      let chatInstance!: Chat<UIMessage>;

      function Harness() {
        const [chat] = useState(() => {
          const transport = new DefaultChatTransport({
            api: "/api/chat",
            fetch: async () =>
              new Response(
                new ReadableStream({
                  async start(ctrl) {
                    const enc = new TextEncoder();
                    ctrl.enqueue(
                      enc.encode(
                        `data: ${JSON.stringify({ type: "start", messageId: "a1" })}\n\n`,
                      ),
                    );
                    ctrl.enqueue(
                      enc.encode(
                        `data: ${JSON.stringify({ type: "text-start", id: "t1" })}\n\n`,
                      ),
                    );
                    for (let i = 0; i < 60; i++) {
                      await new Promise((r) => setTimeout(r, 6));
                      ctrl.enqueue(
                        enc.encode(
                          `data: ${JSON.stringify({ type: "text-delta", id: "t1", delta: "w" })}\n\n`,
                        ),
                      );
                    }
                    ctrl.enqueue(
                      enc.encode(
                        `data: ${JSON.stringify({ type: "text-end", id: "t1" })}\n\n`,
                      ),
                    );
                    ctrl.enqueue(
                      enc.encode(
                        `data: ${JSON.stringify({ type: "finish", finishReason: "stop" })}\n\n`,
                      ),
                    );
                    ctrl.enqueue(enc.encode("data: [DONE]\n\n"));
                    ctrl.close();
                  },
                }),
                { headers: UI_MESSAGE_STREAM_HEADERS },
              ),
          });
          return new Chat({
            id: "chat_paced_test",
            transport,
            onError: (err) => {
              observedError = err;
            },
          });
        });
        chatInstance = chat;

        // Use a 2ms throttle (< 6ms chunk spacing) so every chunk exceeds the
        // throttle window while `tick` fires `DefaultLane` timer updates.
        const { messages, status, error } = useChatState(chat, 2);
        const [tick, setTick] = useState(0);
        const isBusy = status === "submitted" || status === "streaming";

        useEffect(() => {
          if (!isBusy) return;
          const id = setInterval(() => setTick((t) => t + 1), 10);
          return () => clearInterval(id);
        }, [isBusy]);

        return React.createElement(
          "div",
          null,
          error ? error.message : `${tick}:${status}:${messages.length}`,
        );
      }

      const root = createRoot(dom.container);
      flushSync(() => root.render(React.createElement(Harness)));
      await new Promise((r) => setTimeout(r, 15));

      await chatInstance.sendMessage({ text: "test paced" });
      await new Promise((r) => setTimeout(r, 20));

      expect(observedError).toBeUndefined();
      expect(chatInstance.error).toBeUndefined();
      expect(chatInstance.status).toBe("ready");

      root.unmount();
      await new Promise((r) => setTimeout(r, 10));
    } finally {
      dom.restore();
    }
  });

  it("re-subscribes status and error cleanly when switching Chat instances", async () => {
    const dom = installMinimalDom();
    try {
      const chats: Record<string, Chat<UIMessage>> = {};
      let setChatIdFn!: (id: string) => void;
      let renderedStatus = "";
      let renderedError = "";

      function Harness() {
        const [chatId, setChatId] = useState("chat_initial");
        setChatIdFn = setChatId;
        const chat = useMemo(() => {
          const transport = new DefaultChatTransport({
            api: "/api/chat",
            fetch: async () => {
              await new Promise((r) => setTimeout(r, 30));
              return new Response(JSON.stringify({ error: `fail_${chatId}` }), {
                status: 429,
              });
            },
          });
          const c = new Chat({ id: chatId, transport });
          chats[chatId] = c;
          return c;
        }, [chatId]);

        const { status, error } = useChatState(chat, 5);
        renderedStatus = status;
        renderedError = error?.message ?? "";
        return React.createElement(
          "div",
          null,
          `${chatId}:${status}:${renderedError}`,
        );
      }

      const root = createRoot(dom.container);
      flushSync(() => root.render(React.createElement(Harness)));
      await new Promise((r) => setTimeout(r, 15));

      // Switch active chat (mirrors restoring saved thread / clicking New chat).
      flushSync(() => setChatIdFn("chat_switched"));
      await new Promise((r) => setTimeout(r, 15));

      await chats.chat_switched.sendMessage({ text: "hello" });
      await new Promise((r) => setTimeout(r, 25));

      expect(chats.chat_switched.status).toBe("error");
      expect(renderedStatus).toBe("error");
      expect(renderedError).toContain("fail_chat_switched");

      root.unmount();
      await new Promise((r) => setTimeout(r, 10));
    } finally {
      dom.restore();
    }
  });
});
