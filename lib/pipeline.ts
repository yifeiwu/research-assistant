import "server-only";
import { generateText, type LanguageModel } from "ai";
import { createConcurrencyLimiter, type ExaDocument } from "./exa";
import { logDebug, logError } from "./logger";

// Short excerpts pass through untouched without spending a summarizer call.
const PASSTHROUGH_CHAR_LIMIT = 1_500;

// Cap the content handed to the summarizer so the map step stays well within
// free-tier context / tokens-per-minute limits.
const SUMMARY_INPUT_CHAR_CAP = 16_000;

// Hard cap used as a fallback when the summarizer call fails or times out.
const FALLBACK_CHAR_CAP = 4_000;

// Concurrent map summarizations per request.
const SUMMARY_CONCURRENCY = 4;

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
  if (doc.publishedDate) {
    lines.push(`Published: ${doc.publishedDate}`);
  }
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

/**
 * The "map" step: condense a single retrieved web document into compact,
 * source-attributed research notes with a canonical URL header preserved.
 */
export async function condenseSource(
  doc: ExaDocument,
  opts: {
    model: LanguageModel;
    query: string;
    signal?: AbortSignal;
    requestId?: string;
  },
): Promise<string> {
  const header = formatSourceHeader(doc);
  const rawBody = doc.text.trim();

  if (!rawBody) {
    return `${header}\n- (No extractable page text returned.)`;
  }

  if (rawBody.length <= PASSTHROUGH_CHAR_LIMIT) {
    return `${header}\n${rawBody}`;
  }

  const input = rawBody.slice(0, SUMMARY_INPUT_CHAR_CAP);

  try {
    const { text } = await generateText({
      model: opts.model,
      system: SUMMARY_SYSTEM_PROMPT,
      maxOutputTokens: 700,
      abortSignal: opts.signal,
      timeout: { totalMs: 25_000 },
      maxRetries: 1,
      prompt: `Research question:\n${opts.query || "(not provided)"}\n\nSource: ${doc.title ?? doc.url}\nURL: ${doc.url}\n\nWeb content to condense:\n"""\n${input}\n"""\n\nWrite concise research notes (bullet points). Attribute claims to the source, distinguish fact from opinion, and flag any reliability concerns.`,
    });

    const cleaned = stripThinking(text);
    if (cleaned.length > 0) {
      logDebug("summarize", {
        requestId: opts.requestId,
        url: doc.url,
        rawChars: rawBody.length,
        notesChars: cleaned.length,
      });
      return `${header}\n${cleaned}`;
    }

    return `${header}\n${input.slice(0, FALLBACK_CHAR_CAP)}`;
  } catch (error) {
    if (isAbortError(error) || opts.signal?.aborted) {
      throw new DOMException("The operation was aborted.", "AbortError");
    }
    logError("summarize", error, { requestId: opts.requestId, url: doc.url });
    return `${header}\n${input.slice(0, FALLBACK_CHAR_CAP)}`;
  }
}

/**
 * Condense multiple retrieved sources concurrently (bounded to 4 at a time so
 * free-tier TPM limits aren't stampeded while keeping latency low).
 */
export async function condenseSources(
  docs: ExaDocument[],
  opts: {
    model: LanguageModel;
    query: string;
    signal?: AbortSignal;
    requestId?: string;
    concurrency?: number;
  },
): Promise<string[]> {
  const limit = createConcurrencyLimiter(
    opts.concurrency ?? SUMMARY_CONCURRENCY,
  );
  return Promise.all(
    docs.map((doc) => limit(() => condenseSource(doc, opts))),
  );
}
