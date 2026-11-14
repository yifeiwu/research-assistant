/**
 * Rough token estimation for budget enforcement. Uses the common
 * ~4 characters/token heuristic for English prose — good enough to keep
 * requests comfortably under provider TPM/request-size caps without pulling
 * in a tokenizer dependency. Slightly conservative for code/URLs (which
 * tokenize denser), which is the safe direction for a budget.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Truncate text to at most `maxTokens` estimated tokens. */
export function truncateToTokenBudget(text: string, maxTokens: number): string {
  const maxChars = Math.max(0, maxTokens) * 4;
  return text.length <= maxChars ? text : text.slice(0, maxChars);
}
