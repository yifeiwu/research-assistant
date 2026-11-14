import { describe, expect, it } from "vitest";
import { collectSources, normalizeUrlKey } from "@/lib/sources";
import { chatRequestSchema } from "@/lib/types/chat";

describe("normalizeUrlKey", () => {
  it("canonicalises www, case, fragment and trailing slash together", () => {
    expect(normalizeUrlKey("https://www.Example.com/a/#frag")).toBe(
      normalizeUrlKey("https://example.com/a"),
    );
  });
});

describe("collectSources", () => {
  it("dedupes www/fragment variants of the same source", () => {
    const message = {
      parts: [
        { type: "source-url", url: "https://www.a.com/x/", title: "A" },
        { type: "source-url", url: "https://a.com/x#section" },
      ],
    };
    expect(collectSources(message)).toHaveLength(1);
  });
});

describe("chatRequestSchema id validation", () => {
  const base = {
    messages: [{ role: "user", parts: [{ type: "text", text: "hi" }] }],
  };
  it("accepts a uuid chat id", () => {
    expect(
      chatRequestSchema.safeParse({ ...base, id: "123e4567-e89b-12d3-a456-426614174000" }).success,
    ).toBe(true);
  });
  it("rejects ids that can never address a Redis stream", () => {
    expect(chatRequestSchema.safeParse({ ...base, id: "bad id!!" }).success).toBe(false);
    expect(chatRequestSchema.safeParse({ ...base, id: "../etc/passwd" }).success).toBe(false);
  });
});
