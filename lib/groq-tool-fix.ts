import "server-only";
import {
  NoSuchToolError,
  type ToolCallRepairFunction,
  type ToolSet,
} from "ai";
import { logInfo } from "@/lib/logger";

/**
 * How many times to re-issue a request that Groq rejected with
 * `tool_use_failed` (see below). Each retry is a full regeneration, so keep this
 * small; in practice the failure clears within one or two attempts.
 */
const MAX_TOOL_USE_RETRIES = 2;

/**
 * Return the request init with Groq's `disable_tool_validation` flag set, but
 * only for tool-calling requests whose body is JSON we can safely amend.
 *
 * Some Groq/Llama models occasionally embed the tool arguments inside the tool
 * NAME (e.g. `web_search_exa {"query": "..."}`). Groq then rejects the
 * follow-up turn with a 400: "tool call validation failed ... was not in
 * request.tools". Disabling server-side validation lets the response through so
 * we can repair the mangled call locally (see `repairMangledToolCall`).
 */
function withToolValidationDisabled(
  init: RequestInit | undefined,
): RequestInit | undefined {
  if (!init?.body || typeof init.body !== "string") return init;
  try {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    if (Array.isArray(body.tools) && body.tools.length > 0) {
      body.disable_tool_validation = true;
      return { ...init, body: JSON.stringify(body) };
    }
  } catch {
    // Body isn't JSON we can safely amend; fall through.
  }
  return init;
}

/**
 * Detect Groq's `tool_use_failed` error. Unlike the mangled-name case above,
 * here Groq's server-side parser can't turn the model's output into a valid
 * function call at all, so it rejects the whole generation with a 400 before
 * our client-side repair ever sees it. These failures are non-deterministic
 * (Groq regenerates at its default temperature), so a bounded retry usually
 * clears them.
 */
function isToolUseFailed(status: number, bodyText: string): boolean {
  return status === 400 && bodyText.includes("tool_use_failed");
}

/**
 * Custom fetch that (1) disables Groq's tool-name validation and (2) retries a
 * bounded number of times when Groq returns `tool_use_failed`.
 */
export const groqToolValidationFetch: typeof fetch = async (input, init) => {
  const nextInit = withToolValidationDisabled(init);

  let response = await fetch(input, nextInit);
  for (let attempt = 1; attempt <= MAX_TOOL_USE_RETRIES; attempt++) {
    if (response.status !== 400) break;
    // Safe to buffer: Groq returns a plain JSON error body (not an SSE stream)
    // on 400, and we only reach here when the status is 400.
    const bodyText = await response.clone().text();
    if (!isToolUseFailed(response.status, bodyText)) break;
    logInfo("groq-tool-use-retry", { attempt, of: MAX_TOOL_USE_RETRIES });
    response = await fetch(input, nextInit);
  }
  return response;
};

/**
 * Pure helper: given a possibly-mangled tool name and the set of known tool
 * names, return the real tool name and the leftover (argument) string.
 */
function splitMangledToolName(
  mangled: string,
  knownNames: string[],
): { name: string; args: string } | null {
  const match = knownNames.find(
    (name) => mangled === name || mangled.startsWith(name),
  );
  if (!match || match === mangled) return null;

  let rest = mangled.slice(match.length).trim();
  // Handle both `name {json}` and `name,{json}` styles.
  if (rest.startsWith(",")) rest = rest.slice(1).trim();
  return { name: match, args: rest };
}

/**
 * Repairs tool calls where Groq glued the JSON arguments onto the tool name.
 * Runs only for unknown-tool errors and only when the mangled name clearly
 * starts with a real tool name; otherwise it bails out (returns null).
 */
export const repairMangledToolCall: ToolCallRepairFunction<ToolSet> = async ({
  toolCall,
  tools,
  error,
}) => {
  if (!NoSuchToolError.isInstance(error)) return null;

  const split = splitMangledToolName(toolCall.toolName, Object.keys(tools));
  if (!split) return null;

  let input = toolCall.input?.trim() ?? "";
  if (!input || input === "{}" || input === "null") {
    input = split.args;
  }

  // Only return a repaired call if we end up with parseable JSON arguments.
  try {
    JSON.parse(input);
  } catch {
    try {
      JSON.parse(split.args);
      input = split.args;
    } catch {
      return null;
    }
  }

  return { ...toolCall, toolName: split.name, input };
};
