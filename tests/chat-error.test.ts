import { describe, expect, it } from "vitest";
import { describeChatError } from "@/lib/chat-error";

describe("describeChatError", () => {
  it("decodes minified React error #185 instead of blaming models/API keys", () => {
    const info = describeChatError(
      new Error(
        "Minified React error #185; visit https://react.dev/errors/185 for the full message or use the non-minified dev environment for full errors and additional helpful warnings.",
      ),
    );
    expect(info.title).toContain("React #185");
    expect(info.detail).toContain("Maximum update depth exceeded");
    expect(info.detail).toContain("not a problem with the model");
    expect(info.hint).toContain("reload the page");
    expect(info.hint).not.toContain("API keys are set");
    // Raw minified string is kept, but only as collapsed technical detail.
    expect(info.technical).toContain("Minified React error #185");
  });

  it("decodes the unminified maximum-update-depth message too", () => {
    const info = describeChatError(
      new Error("Maximum update depth exceeded. This can happen when a component calls setState inside useEffect."),
    );
    expect(info.title).toContain("React #185");
  });

  it("labels unknown React codes generically but descriptively", () => {
    const info = describeChatError(new Error("Minified React error #999; visit https://react.dev/errors/999"));
    expect(info.title).toBe("Client-side rendering error (React #999)");
    expect(info.detail).toContain("#999");
  });

  it("parses Groq rate limits with model, window, and retry delay", () => {
    const info = describeChatError(
      new Error(
        "Rate limit reached for model `qwen/qwen3.8-27b` in organization `org_1` service tier `on_demand` on output tokens per minute (OTPM): Limit 1000, Used 825, Requested 515. Please try again in 20.4s.",
      ),
    );
    expect(info.title).toBe("Model rate limit reached");
    expect(info.detail).toContain("qwen/qwen3.8-27b");
    expect(info.detail).toContain("OTPM");
    expect(info.detail).toContain("limit 1000");
    expect(info.hint).toContain("20.4s");
  });

  it("distinguishes the app's own per-visitor rate limit", () => {
    const info = describeChatError(
      new Error("You're sending messages too quickly. Please wait a moment and try again."),
    );
    expect(info.title).toContain("too quickly");
    expect(info.hint).toContain("Wait a moment");
  });

  it("describes network disconnects", () => {
    const info = describeChatError(new TypeError("Load failed"));
    expect(info.title).toBe("Connection dropped");
  });

  it("describes auth, oversize, and missing-model failures", () => {
    expect(describeChatError(new Error("401 Invalid API key provided")).title).toBe("API key rejected");
    expect(describeChatError(new Error("Request too large for model: Limit 7000, Requested 7488")).title).toBe("Request too large for the model");
    expect(describeChatError(new Error("model `foo` does not exist")).title).toBe("Model not available");
  });

  it("falls back to the raw message with a neutral hint, truncated", () => {
    const info = describeChatError(new Error("x".repeat(2_000)));
    expect(info.title).toBe("Something went wrong");
    expect(info.detail.length).toBeLessThanOrEqual(601);
    expect(info.hint).not.toContain("switch models");
  });

  it("handles non-Error and empty values", () => {
    expect(describeChatError(undefined).detail).toContain("without an error message");
    expect(describeChatError("boom").detail).toBe("boom");
  });
});
