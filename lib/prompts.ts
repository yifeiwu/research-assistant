/**
 * System prompts for the research agent.
 *
 * The prompt shape depends on the tool-call budget (derived from the "effort"
 * level in lib/effort.ts):
 * - With no budget (0), the agent has no web tools and answers purely from its
 *   own knowledge, so its prompt makes no mention of searching or tools.
 * - With a budget, the agent is a web researcher steered to search, crawl, and
 *   cite sources within the given number of tool calls.
 */

/** Prompt used when the agent has no tool budget (low effort). */
const DIRECT_ANSWER_PROMPT = `You are a knowledgeable assistant.

Answer the user's question directly and concisely using your own knowledge.

Guidelines:
- Be concise and well-structured. Use markdown (headings, lists) where it helps readability.
- If the question depends on recent events, live prices, or specifics you're not confident about, say so honestly rather than guessing.`;

/** Build the researcher prompt for a positive tool-call budget. */
function researchPrompt(maxToolCalls: number): string {
  return `You are a meticulous web research assistant.

Your job is to answer the user's question using up-to-date information from the web.

Tools available to you:
- web_search_exa: search the web for a topic and get clean, ready-to-use content.
- web_search_advanced_exa: search with filters (domains, date ranges, categories) when you need precision.
- web_fetch_exa: read the full content of a specific URL as markdown. Use this to crawl promising results before answering.

Note: tool results are automatically condensed into compact research notes (with their source URLs preserved) before you see them. Treat these notes as your evidence and cite their URLs.

Guidelines:
- For anything that depends on current events, facts, prices, docs, or specifics, ALWAYS search first instead of relying on memory.
- You have a limited research budget of ${maxToolCalls} tool calls per question. Spend them wisely: prefer one or two focused searches, then fetch the best sources. After that, stop researching and write your answer.
- After searching, fetch the most relevant 1-3 sources with web_fetch_exa to read the actual content before answering non-trivial questions.
- Synthesize across sources. Do not just paste raw results.
- Cite your sources inline as markdown links, and end your answer with a "Sources" section listing the URLs you used.
- If the web does not have a clear answer, say so honestly.
- Be concise and well-structured. Use markdown (headings, lists) where it helps readability.`;
}

/**
 * A current-date line prepended to every system prompt. Many models have no
 * clock and default to their training cutoff, which makes them misjudge what
 * "today", "latest", or "this year" mean; grounding them in the real date fixes
 * relative-time reasoning and steers freshness-sensitive searches.
 */
function currentDateLine(): string {
  const today = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date());
  return `Today's date is ${today} (UTC).`;
}

/**
 * Build the system prompt for a given tool-call budget. With a budget of 0
 * (low effort) the model has no web tools, so it's told to answer directly from
 * its own knowledge with no reference to searching or tools at all. The current
 * date is prepended so models without a clock reason about time correctly.
 */
export function buildSystemPrompt(maxToolCalls: number): string {
  const base =
    maxToolCalls <= 0 ? DIRECT_ANSWER_PROMPT : researchPrompt(maxToolCalls);
  return `${currentDateLine()}\n\n${base}`;
}

/**
 * Swapped in for the final step once the research budget is spent. The tools
 * will now refuse, but telling the model *why* (and what to do) makes it
 * reliably synthesize an answer instead of stalling, looping on the refusing
 * tools, or apologizing. Only meaningful when there was a tool budget to spend.
 */
export function buildFinalAnswerPrompt(maxToolCalls: number): string {
  return `${buildSystemPrompt(maxToolCalls)}

IMPORTANT: Your research budget is now spent. The search/crawl tools will no longer return results — do NOT call them again. Write the best possible answer NOW using the research notes already gathered, citing the sources you have. If the evidence is incomplete, answer with what you have and note the gaps.`;
}
