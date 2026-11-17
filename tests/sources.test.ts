import { describe, expect, it } from "vitest";
import {
  collectSources,
  normalizeUrlKey,
  splitSourcesByCitation,
} from "@/lib/sources";
import { chatRequestSchema } from "@/lib/types/chat";

describe("normalizeUrlKey", () => {
  it("canonicalises www, case, fragment and trailing slash together", () => {
    expect(normalizeUrlKey("https://www.Example.com/a/#frag")).toBe(
      normalizeUrlKey("https://example.com/a"),
    );
  });

  it("strips tracking query parameters while preserving and sorting meaningful ones", () => {
    expect(
      normalizeUrlKey(
        "https://www.example.com/report/?utm_source=newsletter&b=2&fbclid=abc123&a=1&utm_medium=email",
      ),
    ).toBe("https://example.com/report?a=1&b=2");
    expect(normalizeUrlKey("https://example.com/post?gclid=xyz&mc_cid=11")).toBe(
      "https://example.com/post",
    );
  });
});

describe("collectSources & splitSourcesByCitation", () => {
  it("dedupes www/fragment variants of the same source", () => {
    const message = {
      text: "",
      sources: [
        { url: "https://www.a.com/x/", title: "A" },
        { url: "https://a.com/x#section" },
      ],
    };
    expect(collectSources(message)).toHaveLength(1);
  });

  it("puts the sources the answer links to first, and keeps the rest as also read", () => {
    const message = {
      text: "As [Two](https://www.b.com/two/) says, and [Foo](https://en.wikipedia.org/wiki/Foo_(bar)). See https://d.com/four.",
      sources: [
        { url: "https://a.com/one", title: "One" },
        { url: "https://b.com/two", title: "Two" },
        { url: "https://en.wikipedia.org/wiki/Foo_(bar)", title: "Foo" },
        { url: "https://d.com/four", title: "Four" },
      ],
    };
    const { cited, other } = splitSourcesByCitation(message);
    expect(cited.map((s) => s.title)).toEqual(["Two", "Foo", "Four"]);
    expect(cited.find((s) => s.title === "Foo")?.url).toBe(
      "https://en.wikipedia.org/wiki/Foo_(bar)",
    );
    expect(other.map((s) => s.title)).toEqual(["One"]);
  });

  it("cites nothing for an answer without links", () => {
    const message = {
      text: "No links here.",
      sources: [{ url: "https://a.com/one", title: "One" }],
    };
    const { cited, other } = splitSourcesByCitation(message);
    expect(cited).toEqual([]);
    expect(other).toHaveLength(1);
  });
});

describe("chatRequestSchema id validation", () => {
  const base = {
    messages: [{ id: "u1", role: "user" as const, text: "hi" }],
  };
  it("accepts a uuid chat id", () => {
    expect(
      chatRequestSchema.safeParse({ ...base, id: "123e4567-e89b-12d3-a456-426614174000" }).success,
    ).toBe(true);
  });
  it("rejects ids that can never address a Redis key or unsafe non-http source URLs", () => {
    expect(chatRequestSchema.safeParse({ ...base, id: "bad id!!" }).success).toBe(false);
    expect(chatRequestSchema.safeParse({ ...base, id: "../etc/passwd" }).success).toBe(false);
    expect(
      chatRequestSchema.safeParse({
        messages: [
          {
            id: "a1",
            role: "assistant",
            text: "x",
            sources: [{ url: "javascript:alert(1)" }],
          },
        ],
      }).success,
    ).toBe(false);
  });
});
