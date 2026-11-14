import { describe, expect, it } from "vitest";
import { verifyCitations } from "@/lib/citations";

const sources = [{ url: "https://www.example.com/a/", title: "A" }];

describe("verifyCitations", () => {
  it("keeps verified citations untouched (www/trailing-slash variants)", () => {
    const text = "See [A](https://example.com/a) and https://example.com/a.";
    const out = verifyCitations(text, sources);
    expect(out.verifiedCount).toBeGreaterThanOrEqual(1);
    expect(out.text).toContain("[A](https://example.com/a)");
  });
  it("de-links invented markdown citations, keeping the label", () => {
    const out = verifyCitations("Claim [Fake](https://evil.example/x).", sources);
    expect(out.text).toBe("Claim Fake.");
    expect(out.strippedCount).toBe(1);
  });
  it("removes invented bare URLs", () => {
    const out = verifyCitations("Visit https://nope.example/y now", sources);
    expect(out.text).not.toContain("nope.example");
    expect(out.strippedCount).toBe(1);
  });
  it("leaves fenced code blocks untouched", () => {
    const text = "```\nfetch('https://api.example.com/v1')\n```";
    const out = verifyCitations(text, sources);
    expect(out.text).toBe(text);
    expect(out.strippedCount).toBe(0);
  });
  it("de-links everything when there are no retrieved sources", () => {
    const out = verifyCitations("[X](https://x.example/) https://y.example/", []);
    expect(out.text).not.toContain("http");
    expect(out.strippedCount).toBe(2);
  });
  it("keeps a verified bare URL with trailing sentence punctuation", () => {
    const out = verifyCitations("See https://example.com/a.", sources);
    expect(out.text).toContain("https://example.com/a");
    expect(out.strippedCount).toBe(0);
    expect(out.verifiedCount).toBe(1);
  });
  it("keeps parenthesised URLs in markdown links", () => {
    const wiki = [{ url: "https://en.wikipedia.org/wiki/Foo_(bar)" }];
    const out = verifyCitations("[Wiki](https://en.wikipedia.org/wiki/Foo_(bar))", wiki);
    expect(out.text).toContain("[Wiki](https://en.wikipedia.org/wiki/Foo_(bar))");
    expect(out.strippedCount).toBe(0);
  });
  it("leaves inline code spans untouched", () => {
    const text = "Run `curl https://nope.example/x` now";
    const out = verifyCitations(text, sources);
    expect(out.text).toBe(text);
    expect(out.strippedCount).toBe(0);
  });
});
