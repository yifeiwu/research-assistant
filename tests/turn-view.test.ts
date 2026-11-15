import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { endsUnanswered } from "@/lib/messages";
import { hasCaughtUp, withHeldMessage } from "@/lib/turn-view";

const user = (id: string, text: string): UIMessage => ({
  id,
  role: "user",
  parts: [{ type: "text", text }],
});

/** An assistant message as a turn builds it: a research card, then answer text. */
const assistant = (id: string, opts: { research?: boolean; text?: string }): UIMessage => ({
  id,
  role: "assistant",
  parts: [
    ...(opts.research
      ? [
          {
            type: "data-research-step" as const,
            id: "research-r1",
            data: { round: 1, phase: "done", queries: ["q"], sources: [] },
          },
        ]
      : []),
    ...(opts.text != null ? [{ type: "text" as const, text: opts.text }] : []),
  ],
});

describe("endsUnanswered", () => {
  it("is true for a thread that ends on the user's message", () => {
    expect(endsUnanswered([user("u1", "hi")])).toBe(true);
  });

  it("is true when the assistant only got as far as research, or nowhere", () => {
    expect(endsUnanswered([user("u1", "hi"), assistant("a1", { research: true })])).toBe(true);
    expect(endsUnanswered([user("u1", "hi"), assistant("a1", {})])).toBe(true);
    expect(endsUnanswered([user("u1", "hi"), assistant("a1", { text: "  \n" })])).toBe(true);
  });

  it("is false once there is answer text, and for an empty thread", () => {
    expect(endsUnanswered([user("u1", "hi"), assistant("a1", { text: "Hello." })])).toBe(false);
    expect(endsUnanswered([])).toBe(false);
  });
});

describe("holding a message while its turn is replayed", () => {
  const prompt = user("u1", "what is new?");
  const held = assistant("msg-1", { research: true, text: "Half of the ans" });

  it("shows the held message until the replay has anything to show", () => {
    // The message was taken out of the chat, and the replay has not begun.
    expect(withHeldMessage([prompt], held)).toEqual([prompt, held]);
  });

  it("keeps showing it while the replay is still behind", () => {
    const behind = [
      assistant("msg-1", {}),
      assistant("msg-1", { research: true }),
      assistant("msg-1", { research: true, text: "Half" }),
    ];
    for (const replayed of behind) {
      expect(hasCaughtUp(replayed, held)).toBe(false);
      expect(withHeldMessage([prompt, replayed], held)).toEqual([prompt, held]);
    }
  });

  it("switches to the replayed message once it shows as much, or more", () => {
    const same = assistant("msg-1", { research: true, text: "Half of the ans" });
    const further = assistant("msg-1", { research: true, text: "Half of the answer, and more." });
    for (const replayed of [same, further]) {
      const live = [prompt, replayed];
      expect(hasCaughtUp(replayed, held)).toBe(true);
      // The very same array, so nothing re-renders for the switch.
      expect(withHeldMessage(live, held)).toBe(live);
    }
  });

  it("leaves the messages alone when nothing is held", () => {
    const live = [prompt, held];
    expect(withHeldMessage(live, null)).toBe(live);
  });
});
