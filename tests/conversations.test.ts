import React from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import {
  deriveTitle,
  loadConversations,
  saveConversations,
  stripConversationNotes,
  type Conversation,
} from "@/lib/conversations";
import {
  matchesPendingTurn,
  toWireMessages,
  useConversations,
  type UseConversations,
} from "@/lib/hooks/useConversations";
import { collectPriorSources, toModelMessages } from "@/lib/messages";
import { chatRequestSchema, type DurableTurnState } from "@/lib/types/chat";

describe("conversations persistence & multi-turn message helpers", () => {
  it("derives clean titles from the first user message", () => {
    expect(
      deriveTitle([{ id: "u1", role: "user", text: "   Compare   Groq and Exa  \n" }]),
    ).toBe("Compare Groq and Exa");
    expect(deriveTitle([])).toBe("New chat");
  });

  it("strips bulky condensed step notes in localStorage while keeping in-memory notes intact", () => {
    const store = new Map<string, string>();
    const prevWindow = (globalThis as Record<string, unknown>).window;
    (globalThis as Record<string, unknown>).window = {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => {
          store.set(k, v);
        },
        removeItem: (k: string) => {
          store.delete(k);
        },
      },
    };

    try {
      const conv: Conversation = {
        id: "chat-12345678",
        title: "Test",
        createdAt: 1_000,
        updatedAt: 2_000,
        messages: [
          { id: "u1", role: "user", text: "question" },
          {
            id: "a1",
            role: "assistant",
            text: "answer",
            steps: [
              {
                round: 1,
                phase: "done",
                query: "q1",
                sources: [{ url: "https://example.com", title: "Example" }],
                notes: "huge raw condensed notes ".repeat(200),
              },
            ],
          },
        ],
      };

      const stripped = stripConversationNotes(conv);
      expect(stripped.messages[1].steps?.[0].notes).toBeUndefined();

      const inMemory = saveConversations([conv]);
      expect(inMemory[0].messages[1].steps?.[0].notes).toContain("huge raw condensed notes");

      const loaded = loadConversations();
      expect(loaded).toHaveLength(1);
      expect(loaded[0].messages[1].steps?.[0].notes).toBeUndefined();
      expect(loaded[0].messages[1].text).toBe("answer");
    } finally {
      (globalThis as Record<string, unknown>).window = prevWindow;
    }
  });

  it("rejects stale DurableTurnState snapshots from earlier runs via matchesPendingTurn", () => {
    const pendingFollowUp = {
      pending: true,
      pendingRunId: "r_turn_2",
    };
    // Stale Turn 1 snapshot:
    expect(matchesPendingTurn(pendingFollowUp, { runId: "r_turn_1" })).toBe(
      false,
    );
    // Matching Turn 2 snapshot:
    expect(matchesPendingTurn(pendingFollowUp, { runId: "r_turn_2" })).toBe(
      true,
    );
    // Superseded runId on the same chat:
    expect(
      matchesPendingTurn(
        { pending: true, pendingRunId: "r_2b" },
        { runId: "r_2a" },
      ),
    ).toBe(false);
  });

  it("bounds multi-turn history tokens while preserving the latest user prompt and alternating roles", () => {
    const messages = [
      { id: "u1", role: "user" as const, text: "First question" },
      { id: "a1", role: "assistant" as const, text: "Old long answer. ".repeat(400) },
      { id: "u2", role: "user" as const, text: "Second question" },
      {
        id: "a2",
        role: "assistant" as const,
        text: "Recent answer citing [Stripe](https://stripe.com/pricing).",
        sources: [{ url: "https://stripe.com/pricing", title: "Stripe" }],
      },
      { id: "u3", role: "user" as const, text: "Follow-up question about fees?" },
    ];

    const bounded = toModelMessages(messages, 300);
    // Latest user message is always preserved at the end, and history starts with `user`.
    expect(bounded[0].role).toBe("user");
    expect(bounded.at(-1)).toEqual({
      role: "user",
      content: "Follow-up question about fees?",
    });
    expect(JSON.stringify(bounded).length).toBeLessThan(2_000);

    expect(collectPriorSources(messages)).toEqual([
      { url: "https://stripe.com/pricing", title: "Stripe" },
    ]);

    // Huge single-message paste is bounded cleanly so total prompt messages never blow 8K TPM:
    const hugePaste = toModelMessages([
      ...messages,
      { id: "u4", role: "user", text: "Paste ".repeat(6_000) },
    ]);
    expect(JSON.stringify(hugePaste).length).toBeLessThan(12_000);

    // Wire serialization sanitizes oversized/non-http source metadata so follow-up POSTs always pass Zod:
    const wired = toWireMessages([
      {
        id: "legacy:id.1",
        role: "assistant",
        text: "ok",
        sources: [
          { url: "javascript:alert(1)", title: "Bad" },
          {
            url: "https://valid.example.com/doc",
            title: "T".repeat(900),
            publishedDate: "D".repeat(200),
          },
        ],
      },
    ]);
    expect(chatRequestSchema.safeParse({ messages: wired }).success).toBe(true);
    expect(wired[0].sources).toHaveLength(1);
    expect(wired[0].sources?.[0].title?.length).toBe(500);
  });
});

describe("useConversations follow-up, edit & resend integration", () => {
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

    const storage = new Map<string, string>();
    const prevWindow = (globalThis as Record<string, unknown>).window;
    const prevDocument = (globalThis as Record<string, unknown>).document;
    const prevIframe = (globalThis as Record<string, unknown>).HTMLIFrameElement;
    const prevFetch = globalThis.fetch;

    (globalThis as Record<string, unknown>).HTMLIFrameElement = class {};

    const doc: Record<string, unknown> = {
      nodeType: 9,
      visibilityState: "visible",
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

    const win = Object.assign(globalThis, {
      localStorage: {
        getItem: (k: string) => storage.get(k) ?? null,
        setItem: (k: string, v: string) => {
          storage.set(k, v);
        },
        removeItem: (k: string) => {
          storage.delete(k);
        },
      },
      addEventListener() {},
      removeEventListener() {},
    });
    (globalThis as Record<string, unknown>).window = win;
    (globalThis as Record<string, unknown>).document = doc;

    return {
      container: makeNode("div", doc) as unknown as Element,
      restore() {
        (globalThis as Record<string, unknown>).window = prevWindow;
        (globalThis as Record<string, unknown>).document = prevDocument;
        (globalThis as Record<string, unknown>).HTMLIFrameElement = prevIframe;
        globalThis.fetch = prevFetch;
      },
    };
  }

  it("never clobbers follow-up questions or edits with Turn 1's stale Redis snapshot, updates title on Q1 edit, and supports editing while pending", async () => {
    const dom = installMinimalDom();
    try {
      const redisRuns = new Map<string, DurableTurnState>();
      let latestRunId: string | null = null;
      const seenPostRunIds: string[] = [];

      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        const method = (init?.method ?? "GET").toUpperCase();

        if (method === "POST" && url === "/api/chat") {
          await new Promise((r) => setTimeout(r, 40));
          const body = JSON.parse(String(init?.body)) as {
            id: string;
            runId: string;
            messages: Array<{ id: string; role: string; text: string }>;
          };
          seenPostRunIds.push(body.runId);
          const state: DurableTurnState = {
            runId: body.runId,
            chatId: body.id,
            status: "running",
            steps: [],
            sources: [],
            updatedAt: Date.now(),
          };
          redisRuns.set(body.runId, state);
          latestRunId = body.runId;
          return new Response(JSON.stringify(state), {
            status: 202,
            headers: { "content-type": "application/json" },
          });
        }

        if (method === "POST" && url.endsWith("/stop")) {
          const body = JSON.parse(String(init?.body ?? "{}")) as { runId?: string };
          const targetId = body.runId ?? latestRunId;
          if (targetId && redisRuns.has(targetId)) {
            redisRuns.set(targetId, { ...redisRuns.get(targetId)!, status: "stopped" });
          }
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }

        if (method === "GET" && url.startsWith("/api/chat/")) {
          const parsed = new URL(url, "http://localhost");
          const requestedRunId = parsed.searchParams.get("runId") ?? latestRunId;
          const state = requestedRunId ? redisRuns.get(requestedRunId) : undefined;
          if (!state) return new Response(null, { status: 204 });
          return new Response(JSON.stringify(state), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }

        return new Response(null, { status: 404 });
      }) as typeof fetch;

      let api!: UseConversations;
      function Harness() {
        api = useConversations();
        return React.createElement("div", null, `${api.messages.length}:${api.pending}`);
      }

      const root = createRoot(dom.container);
      flushSync(() => root.render(React.createElement(Harness)));
      await new Promise((r) => setTimeout(r, 15));

      // --- 1. Send Turn 1 and finish it ---
      flushSync(() => api.sendMessage("Initial question about Rust", "medium"));
      await new Promise((r) => setTimeout(r, 60));
      expect(api.pending).toBe(true);
      expect(api.conversations[0].title).toBe("Initial question about Rust");

      redisRuns.set(latestRunId!, {
        ...redisRuns.get(latestRunId!)!,
        status: "done",
        message: { id: "a1", role: "assistant", text: "Answer 1 about Rust." },
      });
      await new Promise((r) => setTimeout(r, 1_100));
      expect(api.pending).toBe(false);
      expect(api.messages.map((m) => m.text)).toEqual([
        "Initial question about Rust",
        "Answer 1 about Rust.",
      ]);

      // --- 2. Send Follow-up Question while Redis STILL holds Turn 1's `done` state for 40ms ---
      flushSync(() => api.sendMessage("Follow-up: how fast does it compile?", "medium"));
      // Must stay pending and MUST NOT duplicate "Answer 1 about Rust."!
      await new Promise((r) => setTimeout(r, 80));
      expect(api.pending).toBe(true);
      expect(api.messages.map((m) => m.text)).toEqual([
        "Initial question about Rust",
        "Answer 1 about Rust.",
        "Follow-up: how fast does it compile?",
      ]);

      // Complete Turn 2:
      redisRuns.set(latestRunId!, {
        ...redisRuns.get(latestRunId!)!,
        status: "done",
        message: { id: "a2", role: "assistant", text: "Answer 2 about compile speed." },
      });
      await new Promise((r) => setTimeout(r, 1_100));
      expect(api.pending).toBe(false);
      expect(api.messages.map((m) => m.text)).toEqual([
        "Initial question about Rust",
        "Answer 1 about Rust.",
        "Follow-up: how fast does it compile?",
        "Answer 2 about compile speed.",
      ]);

      // --- 3. Edit Question 1 -> truncates thread, updates sidebar title, and can be edited again while still pending! ---
      const firstUserId = api.messages[0].id;
      flushSync(() =>
        api.editUserMessage(firstUserId, "Edited question about Go", "medium"),
      );
      await new Promise((r) => setTimeout(r, 60));
      expect(api.pending).toBe(true);
      expect(api.conversations[0].title).toBe("Edited question about Go");
      expect(api.messages.map((m) => m.text)).toEqual(["Edited question about Go"]);

      // Edit again WHILE still pending (superseding the running turn instead of dropping the edit!):
      const pendingUserId = api.messages[0].id;
      flushSync(() =>
        api.editUserMessage(pendingUserId, "Refined question about Go generics", "medium"),
      );
      await new Promise((r) => setTimeout(r, 60));
      expect(api.pending).toBe(true);
      expect(api.conversations[0].title).toBe("Refined question about Go generics");
      expect(api.messages.map((m) => m.text)).toEqual([
        "Refined question about Go generics",
      ]);

      // --- 4. Stop and Retry assigns a brand-new runId ---
      flushSync(() => api.stopGeneration());
      expect(api.pending).toBe(false);
      const countBeforeRetry = seenPostRunIds.length;
      flushSync(() => api.retryLastTurn("medium"));
      await new Promise((r) => setTimeout(r, 60));
      expect(seenPostRunIds.length).toBe(countBeforeRetry + 1);
      expect(new Set(seenPostRunIds).size).toBe(seenPostRunIds.length);

      root.unmount();
      await new Promise((r) => setTimeout(r, 15));
    } finally {
      dom.restore();
    }
  });
});
