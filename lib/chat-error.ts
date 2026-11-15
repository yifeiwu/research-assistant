/**
 * Turn raw chat errors into something a user can act on.
 *
 * In production React throws minified errors ("Minified React error #185;
 * visit https://react.dev/errors/185 …") and provider SDKs surface long
 * rate-limit strings, so rendering `error.message` verbatim — under a
 * generic "check your API keys" hint — is actively misleading. This maps
 * the failures we actually see to a title, a plain-language detail, and a
 * hint that matches the cause. The raw message is kept in `technical` so
 * the UI can tuck it behind a disclosure for bug reports.
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

/** Known decodings for the minified React errors we can hit in production. */
const REACT_ERROR_MEANINGS: Record<number, string> = {
  185:
    "Maximum update depth exceeded — a component kept triggering state " +
    "updates while rendering, so React stopped it to prevent an infinite " +
    "loop. This is a bug in this page, not a problem with the model, the " +
    "server, or your API keys; the server may well have finished its answer.",
  418: "The server-rendered page didn't match what React expected on the client (hydration mismatch), so React discarded and re-rendered it.",
  423: "React tried to update a component tree that was suspended in an unexpected place.",
  425: "React couldn't update the page because a component suspended while it was still rendering text.",
};

function describeReactError(code: number, raw: string): ChatErrorInfo {
  const meaning = REACT_ERROR_MEANINGS[code];
  return {
    title: `Client-side rendering error (React #${code})`,
    detail: meaning ?? `React hit an internal error (#${code}) while updating the page.`,
    hint:
      code === 185
        ? "Retry the message; if it happens again, reload the page. If it keeps happening on this conversation, start a new chat — no need to change models or API keys."
        : "Retry the message, or reload the page if it persists.",
    technical: truncate(raw),
  };
}

function describeRateLimit(raw: string): ChatErrorInfo | null {
  if (!/rate limit/i.test(raw)) return null;
  const model = /model `([^`]+)`/.exec(raw)?.[1];
  const window = /\((OTPM|ITPM|TPM|RPM|RPD)\)/.exec(raw)?.[1];
  const limit = /Limit ([\d,]+)/.exec(raw)?.[1];
  const retryIn = /try again in ([\d.]+s)/i.exec(raw)?.[1];
  const bits = [
    model ? `the model \`${model}\`` : "the model",
    window ? `hit its ${window} per-minute limit` : "hit its per-minute rate limit",
    limit ? `(limit ${limit})` : null,
  ].filter(Boolean);
  return {
    title: "Model rate limit reached",
    detail: `Groq reports ${bits.join(" ")}. The free-tier per-minute budget is shared across search planning, summarising, and the final answer, so back-to-back questions can exhaust it.`,
    hint: retryIn
      ? `Wait about ${retryIn} and retry — no need to switch models or change API keys.`
      : "Wait a few seconds and retry — no need to switch models or change API keys.",
    technical: truncate(raw),
  };
}

export function describeChatError(err: unknown): ChatErrorInfo {
  const raw = err instanceof Error ? err.message : String(err ?? "");
  const message = raw.trim();

  // Minified React errors: "Minified React error #185; visit
  // https://react.dev/errors/185?args[]=…" — decode the number.
  const reactCode = /Minified React error #(\d+)/.exec(message);
  if (reactCode) return describeReactError(Number(reactCode[1]), message);
  if (/Maximum update depth exceeded/i.test(message)) {
    return describeReactError(185, message);
  }

  if (/sending messages too quickly/i.test(message)) {
    return {
      title: "You're sending messages too quickly",
      detail: "This app rate-limits chat requests per visitor to protect the shared model quota.",
      hint: "Wait a moment, then retry.",
      technical: truncate(message),
    };
  }

  // The research queue was full, or this turn waited in it too long.
  if (/server is busy with other research requests/i.test(message)) {
    return {
      title: "The server is busy",
      detail:
        "Only a few research requests run at once so they don't exhaust the shared model quota together. The queue was full, or this request waited in it too long.",
      hint: "Wait a minute, then retry.",
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
      hint: "Retry the message; a simpler question or lower effort in Settings may finish faster.",
      technical: truncate(message),
    };
  }

  if (/\b401\b|\b403\b|invalid api key|unauthorized|authentication/i.test(message)) {
    return {
      title: "API key rejected",
      detail: "The model provider refused the request credentials (missing, invalid, or expired API key).",
      hint: "Check that the provider API keys are set correctly in Settings / server environment, then retry.",
      technical: truncate(message),
    };
  }

  if (/\b413\b|request too large|context.*(length|limit)|too many tokens/i.test(message)) {
    return {
      title: "Request too large for the model",
      detail: "The assembled prompt (history plus research notes) exceeded the model's per-request token limit.",
      hint: "Retry, or lower the effort in Settings so less research is gathered; starting a new chat also clears long history.",
      technical: truncate(message),
    };
  }

  if (/\b404\b|model.*not found|decommissioned|does not exist/i.test(message)) {
    return {
      title: "Model not available",
      detail: "The configured model name wasn't found at the provider — it may have been renamed or retired.",
      hint: "Pick a different model in Settings, or update the configured model, then retry.",
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
