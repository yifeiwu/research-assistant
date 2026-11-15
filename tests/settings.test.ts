import { describe, expect, it } from "vitest";
import { sanitizeSettings } from "@/lib/settings";

describe("sanitizeSettings", () => {
  it("whitelists only valid model and effort fields", () => {
    const cleaned = sanitizeSettings({
      customApiKey: "sk-secret",
      model: "qwen/qwen3.8-27b",
      effort: "high",
    });
    expect(cleaned).toEqual({ model: "qwen/qwen3.8-27b", effort: "high" });
    expect(JSON.stringify(cleaned)).not.toContain("sk-secret");
  });

  it("falls back for invalid or retired model/effort", () => {
    expect(sanitizeSettings({ model: "nope", effort: "max" })).toEqual({
      model: "openai/gpt-oss-120b",
      effort: "medium",
    });
    expect(sanitizeSettings({ model: "llama-3.3-70b-versatile" }).model).toBe(
      "openai/gpt-oss-120b",
    );
  });
});
