import { describe, expect, it } from "vitest";
import { sanitizeSettings } from "@/lib/settings";

describe("sanitizeSettings", () => {
  it("strips legacy custom provider secrets", () => {
    const cleaned = sanitizeSettings({
      provider: "custom",
      customBaseURL: "https://example.com/v1",
      customApiKey: "sk-secret",
      customModel: "gpt-x",
      groqModel: "qwen/qwen3.8-27b",
      effort: "high",
    });
    expect(cleaned).toEqual({ model: "qwen/qwen3.8-27b", effort: "high" });
    expect(JSON.stringify(cleaned)).not.toContain("sk-secret");
  });
  it("falls back for invalid model/effort", () => {
    const cleaned = sanitizeSettings({ groqModel: "nope", effort: "max" });
    expect(cleaned.model).toBe("openai/gpt-oss-120b");
    expect(cleaned.effort).toBe("medium");
  });
  it("migrates saved settings using a retired Groq model to the default", () => {
    // llama-3.3-70b-versatile was shut down by Groq on 2026-08-16.
    const cleaned = sanitizeSettings({ model: "llama-3.3-70b-versatile" });
    expect(cleaned.model).toBe("openai/gpt-oss-120b");
  });
});
