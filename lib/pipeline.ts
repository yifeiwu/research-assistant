import "server-only";
import { generateText, type LanguageModel } from "ai";
import { logDebug, logError } from "./logger";
import { asTextResult, mcpOutputToText } from "./mcp-output";
import type { ToolMiddleware } from "./agent/tool-middleware";

// If a tool result is at or below this size, pass it through untouched
// (small results / errors don't need summarizing).
const PASSTHROUGH_CHAR_LIMIT = 1500;

// Cap the content handed to the summarizer so the "map" step itself stays
// well within free-tier context / tokens-per-minute limits.
const SUMMARY_INPUT_CHAR_CAP = 16000;

// Hard cap used as a fallback when the summarizer call fails.
const FALLBACK_CHAR_CAP = 4000;

// Per-tool execution timeout. The installed AI SDK's `timeout` option has no
// per-tool granularity, so we bound each MCP call here instead. Without this, a
// single slow crawl can stall a whole step until the (much larger) stepMs cap.
// On timeout we throw so the SDK records a tool-error and the model can retry a
// different source or answer with what it already has.
const DEFAULT_TOOL_TIMEOUT_MS = 45_000;
const TOOL_TIMEOUT_MS: Record<string, number> = {
  // Crawling a full page is the slowest operation; keep it on a tighter leash.
  web_fetch_exa: 30_000,
};

/** Run `fn`, rejecting if it doesn't settle within `ms`. */
async function withTimeout<T>(
  label: string,
  ms: number,
  fn: () => Promise<T>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Tool "${label}" timed out after ${ms / 1000}s`)),
      ms,
    );
  });
  try {
    return await Promise.race([fn(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Serializes async work so at most one job runs at a time. The model can emit
 * several tool calls in a single step (e.g. fetch 3 URLs at once); each wrapped
 * result would otherwise fire a concurrent summarizer call and burst the cheap
 * model's tokens-per-minute limit. Scoped per request (created in
 * `summarizeMiddleware`) so it never serializes across unrelated requests.
 */
function createMutex(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}

const SUMMARY_SYSTEM_PROMPT = `You compress raw web content into concise, factual research notes while critically evaluating the source.

Rules:
- Keep only information relevant to the research question.
- Preserve concrete facts: names, numbers, dates, quotes, and conclusions.
- ALWAYS preserve every source URL you see, verbatim, so they can be cited later.
- Read the source skeptically. Distinguish verifiable facts from the source's own claims, opinions, or interpretations. Attribute claims to the source rather than stating them as established fact (e.g. "The article claims..." / "According to the author...").
- Flag signs of low reliability: missing evidence or citations, anonymous or unnamed sources, marketing/promotional or advertorial framing, opinion or editorial content, undisclosed conflicts of interest, emotionally loaded or one-sided language, vague or unfalsifiable assertions, outdated information, and claims that contradict well-established consensus.
- Note what the source does NOT substantiate: unsupported figures, cherry-picked data, or conclusions that outrun the evidence presented.
- If credibility signals are relevant, add a short "Reliability:" line noting the source type (e.g. peer-reviewed, news, blog, vendor page) and any caveats a reader should keep in mind.
- Use short bullet points. Keep critique factual and specific; do not editorialize beyond what the content supports.
- If the content is not relevant to the question, say so in one line.`;

/**
 * The "map" step: condense one tool result into compact research notes using a
 * cheap, fast model, focused on the user's research question.
 */
async function condense(
  rawText: string,
  opts: { model: LanguageModel; query: string; requestId?: string },
): Promise<string> {
  const input = rawText.slice(0, SUMMARY_INPUT_CHAR_CAP);

  try {
    const { text } = await generateText({
      model: opts.model,
      system: SUMMARY_SYSTEM_PROMPT,
      maxOutputTokens: 700,
      // Bound the map step so a stalled/rate-limited summary can't block the
      // tool call (and therefore the whole agent loop). On timeout we fall back
      // to a hard truncation below.
      timeout: { totalMs: 25_000 },
      maxRetries: 1,
      prompt: `Research question:\n${opts.query || "(not provided)"}\n\nWeb content to condense:\n"""\n${input}\n"""\n\nWrite concise research notes (bullet points). Attribute claims to the source, distinguish fact from opinion, and flag any reliability concerns (missing evidence, bias, promotional framing, unsupported claims). Preserve all source URLs.`,
    });
    const trimmed = text.trim();
    if (trimmed.length > 0) {
      logDebug("summarize", {
        requestId: opts.requestId,
        rawChars: rawText.length,
        notesChars: trimmed.length,
      });
      return trimmed;
    }
    return input.slice(0, FALLBACK_CHAR_CAP);
  } catch (error) {
    // If summarization fails (e.g. rate limited), fall back to a hard truncation
    // so the main loop still receives a bounded amount of context.
    logError("summarize", error, { requestId: opts.requestId });
    return input.slice(0, FALLBACK_CHAR_CAP);
  }
}

/**
 * Tool middleware implementing the "map" step: large tool results are summarized
 * by a cheap model before they re-enter the main model's context. The main
 * streamText loop performs the reduce (synthesis). Small results pass through
 * untouched. The summarizer mutex is shared across every tool wrapped by one
 * call, so concurrent tool calls in a single step can't stampede the model.
 */
export function summarizeMiddleware(opts: {
  model: LanguageModel;
  query: string;
  requestId?: string;
}): ToolMiddleware {
  const runSummary = createMutex();

  return (execute, name) => {
    const timeoutMs = TOOL_TIMEOUT_MS[name] ?? DEFAULT_TOOL_TIMEOUT_MS;
    return async (...args) => {
      const raw = await withTimeout(name, timeoutMs, () => execute(...args));
      const text = mcpOutputToText(raw);

      if (text.length <= PASSTHROUGH_CHAR_LIMIT) {
        return raw;
      }

      const condensed = await runSummary(() => condense(text, opts));
      return asTextResult(condensed);
    };
  };
}
