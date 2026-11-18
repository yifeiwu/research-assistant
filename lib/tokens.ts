/**
 * Conservative token estimation for budget & rate-limit enforcement. Uses ~3.6
 * characters/token so URLs, numbers, markdown tables, and chat framing never
 * undercount against Groq's rolling per-minute TPM/ITPM/OTPM windows.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.6);
}
