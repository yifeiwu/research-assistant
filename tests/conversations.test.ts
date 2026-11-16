import { describe, expect, it } from "vitest";
import {
  deriveTitle,
  loadConversations,
  saveConversations,
  stripConversationNotes,
  type Conversation,
} from "@/lib/conversations";

describe("conversations persistence", () => {
  it("derives clean titles from the first user message", () => {
    expect(
      deriveTitle([{ id: "u1", role: "user", text: "   Compare   Groq and Exa  \n" }]),
    ).toBe("Compare Groq and Exa");
    expect(deriveTitle([])).toBe("New chat");
  });

  it("strips bulky condensed step notes before persisting to localStorage while keeping queries and sources", () => {
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
      expect(stripped.messages[1].steps?.[0].query).toBe("q1");
      expect(stripped.messages[1].steps?.[0].sources).toHaveLength(1);

      saveConversations([conv]);
      const loaded = loadConversations();
      expect(loaded).toHaveLength(1);
      expect(loaded[0].messages[1].steps?.[0].notes).toBeUndefined();
      expect(loaded[0].messages[1].text).toBe("answer");
    } finally {
      (globalThis as Record<string, unknown>).window = prevWindow;
    }
  });
});
