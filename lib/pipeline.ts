import "server-only";
import { generateText, type LanguageModel } from "ai";
import { createConcurrencyLimiter, type ExaDocument } from "./exa";
import { logDebug, logError } from "./logger";
import { serverConfig } from "./config";
import { normalizeCacheText, requestCache, type RequestCache } from "./cache";

const PASSTHROUGH_CHAR_LIMIT = serverConfig.summary.passthroughCharLimit;
const SUMMARY_INPUT_CHAR_CAP = serverConfig.summary.inputCharCap;
const FALLBACK_CHAR_CAP = serverConfig.summary.fallbackCharCap;
const SUMMARY_CONCURRENCY = serverConfig.summary.concurrency;

/**
 * Strip inline `<think>...</think>` blocks emitted by open-weight reasoning
 * models on OpenAI-compatible endpoints that don't separate reasoning fields.
 */
export function stripThinking(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<think>[\s\S]*$/gi, "")
    .trim();
}

function formatSourceHeader(doc: ExaDocument): string {
  const lines = [`### ${doc.title ?? doc.url}`, `URL: ${doc.url}`];
  if (doc.publishedDate) lines.push(`Published: ${doc.publishedDate}`);
  return lines.join("\n");
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

const SUMMARY_SYSTEM_PROMPT = `You compress raw web content into concise, factual research notes while critically evaluating the source.

Rules:
- Keep only information relevant to the research question.
- Preserve concrete facts: names, numbers, dates, quotes, and conclusions.
- Read the source skeptically. Distinguish verifiable facts from the source's own claims, opinions, or interpretations. Attribute claims to the source rather than stating them as established fact (e.g. "The article claims..." / "According to the author...").
- Flag signs of low reliability: missing evidence or citations, anonymous or unnamed sources, marketing/promotional or advertorial framing, opinion or editorial content, undisclosed conflicts of interest, emotionally loaded or one-sided language, vague or unfalsifiable assertions, outdated information, and claims that contradict well-established consensus.
- Note what the source does NOT substantiate: unsupported figures, cherry-picked data, or conclusions that outrun the evidence presented.
- If credibility signals are relevant, add a short "Reliability:" line noting the source type (e.g. peer-reviewed, news, blog, vendor page) and any caveats a reader should keep in mind.
- Use short bullet points. Keep critique factual and specific; do not editorialize beyond what the content supports.
- Output plain text bullet points only. Do not call tools or wrap output in JSON.
- If the content is not relevant to the question, say so in one line.`;

type CondenseSourceOutcome = { note: string; usedFallback: boolean };

export type CondenseOpts = {
  model: LanguageModel;
  query: string;
  signal?: AbortSignal;
  requestId?: string;
  modelId?: string;
  cache?: RequestCache;
  disableCache?: boolean;
};

/** The "map" step for a single document, reporting fallback use. */
async function condenseSourceDetailed(
  doc: ExaDocument,
  opts: CondenseOpts,
): Promise<CondenseSourceOutcome> {
  const header = formatSourceHeader(doc);
  const rawBody = doc.text.trim();
  if (!rawBody) {
    return { note: `${header}\n- (No extractable page text returned.)`, usedFallback: true };
  }
  if (rawBody.length <= PASSTHROUGH_CHAR_LIMIT) {
    return { note: `${header}\n${rawBody}`, usedFallback: false };
  }

  const input = rawBody.slice(0, SUMMARY_INPUT_CHAR_CAP);
  const cache = opts.cache ?? requestCache;
  try {
    const cleaned = await cache.wrap(
      "notes",
      {
        url: doc.url,
        content: input,
        q: normalizeCacheText(opts.query),
        model: opts.modelId ?? "summary",
      },
      serverConfig.cache.notesTtlSeconds,
      async () => {
        const { text } = await generateText({
          model: opts.model,
          system: SUMMARY_SYSTEM_PROMPT,
          maxOutputTokens: serverConfig.summary.maxOutputTokens,
          // Signal-free loader (shared/coalesced via the cache); the caller's
          // own signal is passed to `wrap` below and only detaches this caller.
          timeout: { totalMs: serverConfig.summary.timeoutMs },
          maxRetries: 1,
          prompt: `Research question:\n${opts.query || "(not provided)"}\n\nSource: ${doc.title ?? doc.url}\nURL: ${doc.url}\n\nWeb content to condense:\n"""\n${input}\n"""\n\nWrite concise research notes (bullet points). Attribute claims to the source, distinguish fact from opinion, and flag any reliability concerns.`,
        });
        const value = stripThinking(text);
        if (!value) throw new Error("Summarizer returned empty notes");
        return value;
      },
      { bypass: opts.disableCache, requestId: opts.requestId, signal: opts.signal },
    );
    logDebug("summarize", {
      requestId: opts.requestId,
      url: doc.url,
      rawChars: rawBody.length,
      notesChars: cleaned.length,
    });
    return { note: `${header}\n${cleaned}`, usedFallback: false };
  } catch (error) {
    if (isAbortError(error) || opts.signal?.aborted) {
      throw new DOMException("The operation was aborted.", "AbortError");
    }
    logError("summarize", error, { requestId: opts.requestId, url: doc.url });
    return { note: `${header}\n${input.slice(0, FALLBACK_CHAR_CAP)}`, usedFallback: true };
  }
}

export type CondenseSourcesOutcome = { notes: string[]; fallbackCount: number };

export async function condenseSourcesDetailed(
  docs: ExaDocument[],
  opts: CondenseOpts & { concurrency?: number },
): Promise<CondenseSourcesOutcome> {
  const limit = createConcurrencyLimiter(opts.concurrency ?? SUMMARY_CONCURRENCY);
  const outcomes = await Promise.all(
    docs.map((doc) => limit(() => condenseSourceDetailed(doc, opts))),
  );
  return {
    notes: outcomes.map((o) => o.note),
    fallbackCount: outcomes.filter((o) => o.usedFallback).length,
  };
}
