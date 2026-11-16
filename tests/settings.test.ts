import { describe, expect, it } from "vitest";
import { sanitizeSettings } from "@/lib/settings";

describe("sanitizeSettings", () => {
  it("whitelists effort and strips legacy model or unknown fields", () => {
    const cleaned = sanitizeSettings({
      customApiKey: "sk-secret",
      model: "qwen/qwen3.8-27b",
      effort: "high",
    });
    expect(cleaned).toEqual({ effort: "high" });
    expect(JSON.stringify(cleaned)).not.toContain("sk-secret");
    expect(JSON.stringify(cleaned)).not.toContain("model");
  });

  it("falls back to medium effort for invalid or non-object values", () => {
    expect(sanitizeSettings({ effort: "max" })).toEqual({ effort: "medium" });
    expect(sanitizeSettings(null)).toEqual({ effort: "medium" });
  });
});
