import { describe, expect, it } from "vitest";
import { sanitizeSettings } from "@/lib/settings";

describe("sanitizeSettings", () => {
  it("strips legacy custom provider secrets", () => {
    const cleaned = sanitizeSettings({
      provider: "custom",
      customBaseURL: "https://example.com/v1",
      customApiKey: "sk-secret",
      customModel: "gpt-x",
      groqModel: "llama-3.3-70b-versatile",
      effort: "high",
    });
    expect(cleaned).toEqual({ model: "llama-3.3-70b-versatile", effort: "high" });
    expect(JSON.stringify(cleaned)).not.toContain("sk-secret");
  });
  it("falls back for invalid model/effort", () => {
    const cleaned = sanitizeSettings({ groqModel: "nope", effort: "max" });
    expect(cleaned.model).toBe("openai/gpt-oss-120b");
    expect(cleaned.effort).toBe("medium");
  });
});
