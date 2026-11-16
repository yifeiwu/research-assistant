/**
 * Turn raw chat errors into something a user can act on.
 *
 * Provider SDKs surface verbose rate-limit strings and generic HTTP failures,
 * so rendering `error.message` verbatim is misleading. This maps the failures
 * we actually see to a title, a plain-language detail, and an actionable hint.
 * The raw message is kept in `technical` for a collapsed disclosure.
 */
export type ChatErrorInfo = {
  title: string;
  detail: string;
  hint: string;
  /** Raw underlying message, for a collapsed technical-details view. */
  technical?: string;
};

const MAX_TECHNICAL_CHARS = 600;

function truncate(text: string): string {
  return text.length > MAX_TECHNICAL_CHARS
    ? `${text.slice(0, MAX_TECHNICAL_CHARS)}…`
    : text;
}

function describeRateLimit(raw: string): ChatErrorInfo | null {
  if (!/rate limit/i.test(raw)) return null;
  const model = /model `([^`]+)`/.exec(raw)?.[1];
  const window = /\((OTPM|ITPM|TPM|RPM|RPD)\)/.exec(raw)?.[1];
  const limit = /Limit ([\d,]+)/.exec(raw)?.[1];
  const retryIn = /try again in (?:about )?((?:\d[\d.]*(?:ms|[hms]))+)/i.exec(raw)?.[1];
  const bits = [
    model ? `the model \`${model}\`` : "the model pool",
    window ? `hit its ${window} per-minute limit` : "hit its per-minute rate limit",
    limit ? `(limit ${limit})` : null,
  ].filter(Boolean);
  return {
    title: "Model rate limit reached",
    detail: `Groq reports ${bits.join(" ")}. The free-tier per-minute budget is shared across search planning, summarising, and the final answer, so back-to-back questions can exhaust it.`,
    hint: retryIn
      ? `Wait about ${retryIn} and retry.`
      : "Wait a few seconds and retry.",
    technical: truncate(raw),
  };
}

export function describeChatError(err: unknown): ChatErrorInfo {
  const raw = err instanceof Error ? err.message : String(err ?? "");
  const message = raw.trim();

  if (/sending messages too quickly/i.test(message)) {
    return {
      title: "You're sending messages too quickly",
      detail: "This app rate-limits chat requests per visitor to protect the shared model quota.",
      hint: "Wait a moment, then retry.",
      technical: truncate(message),
    };
  }

  if (/server is busy with other requests/i.test(message)) {
    return {
      title: "The server is busy",
      detail:
        "Only a few requests run at once so they don't exhaust the shared model quota together. The queue was full, or this request waited in it too long.",
      hint: "Wait a moment, then retry.",
      technical: truncate(message),
    };
  }

  const rateLimit = describeRateLimit(message);
  if (rateLimit) return rateLimit;

  if (
    err instanceof TypeError &&
    /fetch|network|load failed/i.test(message)
  ) {
    return {
      title: "Connection dropped",
      detail: "The browser lost its connection to the server mid-response (network change, sleep, or a dropped stream).",
      hint: "Retry the message — if the response had already started on the server, reopening this chat may recover it.",
      technical: truncate(message),
    };
  }

  if (/abort|timed? ?out|deadline/i.test(message)) {
    return {
      title: "The request timed out",
      detail: "The model or a search step took longer than its time budget and was stopped.",
      hint: "Retry the message; a simpler question or lower Effort in the composer may finish faster.",
      technical: truncate(message),
    };
  }

  if (/\b401\b|\b403\b|invalid api key|unauthorized|authentication/i.test(message)) {
    return {
      title: "API key rejected",
      detail: "The model provider refused the request credentials (missing, invalid, or expired API key).",
      hint: "Check that GROQ_API_KEY is configured correctly in the server environment, then retry.",
      technical: truncate(message),
    };
  }

  if (/\b413\b|request too large|context.*(length|limit)|too many tokens/i.test(message)) {
    return {
      title: "Request too large for the model",
      detail: "The assembled prompt (history plus research notes) exceeded the model's per-request token limit.",
      hint: "Retry, or lower the Effort in the composer so less research is gathered; starting a new chat also clears long history.",
      technical: truncate(message),
    };
  }

  if (/\b404\b|model.*not (?:found|available)|decommissioned|does not exist/i.test(message)) {
    return {
      title: "Model not available",
      detail: "A configured model name wasn't found at the provider — it may have been renamed or retired.",
      hint: "Check the server's model pool configuration, then retry.",
      technical: truncate(message),
    };
  }

  if (/\b429\b/.test(message)) {
    return {
      title: "Too many requests",
      detail: "The provider throttled this request (HTTP 429).",
      hint: "Wait a few seconds and retry.",
      technical: truncate(message),
    };
  }

  if (/\b5\d\d\b/.test(message)) {
    return {
      title: "The server hit an error",
      detail: "The request reached the server but failed there (HTTP 5xx) before an answer could be produced.",
      hint: "Retry the message; if it persists, check the server logs for this request.",
      technical: truncate(message),
    };
  }

  return {
    title: "Something went wrong",
    detail: message
      ? truncate(message)
      : "The request failed without an error message.",
    hint: "Try sending the message again. If it persists, reload the page or start a new chat; the technical detail below may help diagnose it.",
    ...(message ? { technical: truncate(message) } : {}),
  };
}
