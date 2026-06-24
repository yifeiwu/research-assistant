import { generateText, type LanguageModel, type ToolSet } from "ai";

// If a tool result is at or below this size, pass it through untouched
// (small results / errors don't need summarizing).
const PASSTHROUGH_CHAR_LIMIT = 1500;

// Cap the content handed to the summarizer so the "map" step itself stays
// well within free-tier context / tokens-per-minute limits.
const SUMMARY_INPUT_CHAR_CAP = 16000;

// Hard cap used as a fallback when the summarizer call fails.
const FALLBACK_CHAR_CAP = 4000;

type McpTextResult = { content: Array<{ type: "text"; text: string }> };

/**
 * Pull the human-readable text out of an MCP tool result, which is usually
 * shaped like `{ content: [{ type: 'text', text }] }`.
 */
function extractText(output: unknown): string {
  if (output == null) return "";
  if (typeof output === "string") return output;
  if (typeof output === "object") {
    const obj = output as Record<string, unknown>;
    if (Array.isArray(obj.content)) {
      const text = obj.content
        .map((c) =>
          c && typeof c === "object" && "text" in c
            ? String((c as Record<string, unknown>).text)
            : "",
        )
        .join("\n");
      if (text.trim()) return text;
    }
  }
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

function asTextResult(text: string): McpTextResult {
  return { content: [{ type: "text", text }] };
}

const SUMMARY_SYSTEM_PROMPT = `You compress raw web content into concise, factual research notes.

Rules:
- Keep only information relevant to the research question.
- Preserve concrete facts: names, numbers, dates, quotes, and conclusions.
- ALWAYS preserve every source URL you see, verbatim, so they can be cited later.
- Use short bullet points. Do not add commentary, opinions, or preamble.
- If the content is not relevant to the question, say so in one line.`;

/**
 * The "map" step: condense one tool result into compact research notes using a
 * cheap, fast model, focused on the user's research question.
 */
async function condense(
  rawText: string,
  opts: { model: LanguageModel; query: string },
): Promise<string> {
  const input = rawText.slice(0, SUMMARY_INPUT_CHAR_CAP);

  try {
    const { text } = await generateText({
      model: opts.model,
      system: SUMMARY_SYSTEM_PROMPT,
      maxOutputTokens: 700,
      prompt: `Research question:\n${opts.query || "(not provided)"}\n\nWeb content to condense:\n"""\n${input}\n"""\n\nWrite concise research notes (bullet points). Preserve all source URLs.`,
    });
    const trimmed = text.trim();
    return trimmed.length > 0 ? trimmed : input.slice(0, FALLBACK_CHAR_CAP);
  } catch {
    // If summarization fails (e.g. rate limited), fall back to a hard truncation
    // so the main loop still receives a bounded amount of context.
    return input.slice(0, FALLBACK_CHAR_CAP);
  }
}

/**
 * Wraps each Exa MCP tool so that large results are summarized by a cheap model
 * before they re-enter the main model's context. This is the map step of a
 * map-reduce pipeline; the main streamText loop performs the reduce (synthesis).
 */
export function wrapToolsWithSummarizer(
  tools: ToolSet,
  opts: { model: LanguageModel; query: string },
): ToolSet {
  const wrapped: Record<string, unknown> = {};

  for (const [name, tool] of Object.entries(tools)) {
    const original = tool as unknown as {
      execute?: (...args: unknown[]) => Promise<unknown>;
    };

    if (typeof original.execute !== "function") {
      wrapped[name] = tool;
      continue;
    }

    wrapped[name] = {
      ...tool,
      execute: async (...args: unknown[]) => {
        const raw = await original.execute!(...args);
        const text = extractText(raw);

        if (text.length <= PASSTHROUGH_CHAR_LIMIT) {
          return raw;
        }

        const condensed = await condense(text, opts);
        return asTextResult(condensed);
      },
    };
  }

  return wrapped as ToolSet;
}
