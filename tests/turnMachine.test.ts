import { describe, expect, it } from "vitest";
import { initialTurnState, turnReducer } from "@/lib/hooks/turnMachine";

describe("turnReducer", () => {
  it("send resets stop/network markers", () => {
    const stopped = turnReducer(initialTurnState, { type: "STOP", chatId: "chat-1" });
    const sent = turnReducer(stopped, { type: "SEND", chatId: "chat-1" });
    expect(sent.status).toBe("submitted");
    expect(sent.userStopped).toBe(false);
    expect(sent.stoppedChatId).toBeNull();
  });
  it("preserves the stopped marker across a thread switch", () => {
    const stopped = turnReducer(initialTurnState, { type: "STOP", chatId: "chat-1" });
    const switched = turnReducer(stopped, { type: "THREAD_SWITCH", chatId: "chat-2" });
    expect(switched.stoppedChatId).toBe("chat-1");
    const back = turnReducer(switched, { type: "THREAD_SWITCH", chatId: "chat-1" });
    expect(back.userStopped).toBe(true);
  });
  it("distinguishes network drops from explicit stop", () => {
    const net = turnReducer(
      turnReducer(initialTurnState, { type: "SEND", chatId: "c" }),
      { type: "NETWORK_ERROR" },
    );
    expect(net.lastErrorWasNetwork).toBe(true);
    expect(net.userStopped).toBe(false);
    const detached = turnReducer(net, { type: "FINISH_DETACHED", chatId: "c" });
    expect(detached.status).toBe("detached");
  });
  it("resume-empty settles", () => {
    const resuming = turnReducer(initialTurnState, { type: "RESUME_START", chatId: "c" });
    expect(resuming.status).toBe("resuming");
    expect(turnReducer(resuming, { type: "RESUME_EMPTY", chatId: "c" }).status).toBe("settling");
    expect(turnReducer(resuming, { type: "SETTLE", chatId: "c" }).status).toBe("idle");
  });
});
