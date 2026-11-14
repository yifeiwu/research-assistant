/**
 * Tool-free system prompts for the deterministic research pipeline.
 *
 * Every model call in the app receives plain text and outputs plain text — no
 * native function/tool calling or JSON-schema mode is required.
 */

/**
 * A current-date line prepended to every system prompt so models without a
 * real-time clock reason accurately about "today", "latest", or "this year".
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

/** Prompt used when no web search runs (`low` effort or `NO_SEARCH`). */
export function buildDirectAnswerPrompt(): string {
  return `${currentDateLine()}

You are a knowledgeable assistant.

Answer the user's question directly and concisely using your own knowledge.

Guidelines:
- Be concise and well-structured. Use markdown (headings, lists) where it helps readability.
- If the question depends on recent events, live prices, or specifics you're not confident about, say so honestly rather than guessing.`;
}

/**
 * Stage 1 prompt: turns the conversation into 1..maxQueries plain-text web
 * search queries (one per line), or `NO_SEARCH` when external lookup is clearly
 * unnecessary.
 */
export function buildQueryPlanPrompt(maxQueries: number): string {
  return `${currentDateLine()}

You plan web search queries for a research assistant.

Given the conversation so far, decide whether answering the user's latest message benefits from web search.

Output format rules (STRICT):
- If the latest message is purely a greeting, small talk, pure math/logic, or a self-contained rewrite/formatting of text already in the conversation, output ONLY the single token:
NO_SEARCH
- Otherwise, output 1 to ${maxQueries} focused, diverse web search queries — ONE query per line.
- Make each query self-contained (resolve pronouns like "it" or "they" using prior turns) and cover distinct angles of the user's question.
- Include the current year when freshness matters.
- Output ONLY the raw search queries, one per line. No numbering, no bullets, no quotes, no commentary, no JSON.`;
}

/**
 * High-effort gap-check prompt: inspects Round 1 research notes and either
 * finishes (`DONE`) or emits targeted follow-up search queries to fill gaps.
 */
export function buildGapCheckPrompt(maxFollowUps: number): string {
  return `${currentDateLine()}

You evaluate whether gathered web research notes are sufficient to thoroughly answer the user's question.

Output format rules (STRICT):
- If the notes already cover the key facts needed to answer accurately, output ONLY the single token:
DONE
- If important facts, specifics, primary sources, or counterpoints are still missing, output 1 to ${maxFollowUps} targeted follow-up web search queries — ONE query per line — aimed strictly at the missing information.
- Do not repeat queries that were already run.
- Output ONLY "DONE" or raw search queries (one per line). No numbering, no bullets, no quotes, no commentary.`;
}

/**
 * Stage 4 (reduce) prompt: synthesizes the pre-fetched, condensed research
 * notes into a grounded, inline-cited final answer.
 */
export function buildSynthesisPrompt(evidenceBlock: string): string {
  return `${currentDateLine()}

You are a meticulous web research assistant.

Web research has already been executed for you. Answer the user's question using the gathered research notes below as your primary evidence.

Guidelines:
- Ground your claims in the research notes. Synthesize across sources rather than repeating each source one by one.
- Distinguish established facts from claims, projections, or opinions attributed to specific sources, and note any reliability caveats surfaced in the notes.
- Cite sources inline using markdown links — e.g. [Source Name](https://example.com/...) — using ONLY the exact URLs provided in the research notes. Never invent URLs.
- End your answer with a compact "Sources" section listing the markdown links you relied on.
- If the research notes do not fully answer part of the question or conflict with each other, state that transparently rather than guessing.
- Be concise, direct, and well-structured with markdown headings/lists where helpful.

=== RESEARCH NOTES ===
${evidenceBlock}
=== END RESEARCH NOTES ===`;
}
