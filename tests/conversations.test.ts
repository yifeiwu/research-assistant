import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { withTurnPrompt, type Conversation } from "@/lib/conversations";
import { initialTurnState, turnReducer, type TurnEvent } from "@/lib/turn-machine";

const ID = "chat-1";
const NOW = 9_000;

const user = (id: string, text: string): UIMessage => ({
  id,
  role: "user",
  parts: [{ type: "text", text }],
});
const answer = (id: string, text: string): UIMessage => ({
  id,
  role: "assistant",
  parts: [{ type: "text", text }],
});

/** The thread's turn after `events`. */
const turnAfter = (...events: TurnEvent[]) =>
  events.reduce(turnReducer, initialTurnState(ID)).threads[ID];
const sent = turnAfter({ type: "SEND", chatId: ID, at: 5_000 });

const saved = (over: Partial<Conversation>): Conversation => ({
  id: ID,
  title: "First question",
  messages: [],
  createdAt: 1_000,
  updatedAt: 1_000,
  ...over,
});

describe("withTurnPrompt", () => {
  const prompt = [user("u1", "First question")];

  it("saves a new thread's prompt as pending, from when the turn was sent", () => {
    const next = withTurnPrompt([], ID, prompt, sent, NOW);
    expect(next).toEqual([
      {
        id: ID,
        title: "First question",
        messages: prompt,
        pending: true,
        pendingSince: 5_000,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ]);
  });

  it("adds a follow-up turn's prompt to the thread, and moves it to the top", () => {
    const earlier = [user("u1", "First question"), answer("a1", "An answer.")];
    const other = saved({ id: "chat-2", title: "Another thread" });
    const followUp = [...earlier, user("u2", "And then?")];
    const next = withTurnPrompt([other, saved({ messages: earlier })], ID, followUp, sent, NOW);
    expect(next?.map((c) => c.id)).toEqual([ID, "chat-2"]);
    expect(next?.[0]).toMatchObject({ title: "First question", messages: followUp, pending: true });
  });

  it("has nothing to write once the turn is saved as pending", () => {
    const list = [saved({ messages: prompt, pending: true, pendingSince: 5_000 })];
    // Asked again for every update to the answer as it streams.
    expect(withTurnPrompt(list, ID, prompt, sent, NOW)).toBeNull();
  });

  it("saves the prompt, not as pending, for a turn that failed before it could be saved", () => {
    // The request was refused before the page got round to saving anything.
    const failed = turnAfter({ type: "SEND", chatId: ID, at: 5_000 }, { type: "FAILED", chatId: ID });
    const next = withTurnPrompt([], ID, prompt, failed, NOW);
    expect(next?.[0]).toMatchObject({ messages: prompt, pending: false });
    expect(next?.[0].pendingSince).toBeUndefined();
  });

  it("leaves alone what a turn that is already over has saved", () => {
    // The turn finished first, and its answer is saved with the prompt.
    const finished = turnAfter({ type: "SEND", chatId: ID, at: 5_000 }, { type: "FINISHED", chatId: ID });
    const list = [saved({ messages: [...prompt, answer("a1", "An answer.")], pending: false })];
    expect(withTurnPrompt(list, ID, prompt, finished, NOW)).toBeNull();
  });

  it("writes nothing for a thread that has been deleted", () => {
    const deleted = turnAfter({ type: "SEND", chatId: ID, at: 5_000 }, { type: "FORGET", chatId: ID });
    expect(deleted).toBeUndefined();
    expect(withTurnPrompt([], ID, prompt, deleted, NOW)).toBeNull();
  });
});
