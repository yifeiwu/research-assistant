import {
  NoSuchToolError,
  type ToolCallRepairFunction,
  type ToolSet,
} from "ai";

/**
 * Custom fetch that sets Groq's `disable_tool_validation` flag on tool-calling
 * requests.
 *
 * Some Groq/Llama models occasionally embed the tool arguments inside the tool
 * NAME (e.g. `web_search_exa {"query": "..."}`). Groq then rejects the
 * follow-up turn with a 400: "tool call validation failed ... was not in
 * request.tools". Disabling server-side validation lets the response through so
 * we can repair the mangled call locally (see `repairMangledToolCall`).
 */
export const groqToolValidationFetch: typeof fetch = async (input, init) => {
  if (init?.body && typeof init.body === "string") {
    try {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      if (Array.isArray(body.tools) && body.tools.length > 0) {
        body.disable_tool_validation = true;
        return fetch(input, { ...init, body: JSON.stringify(body) });
      }
    } catch {
      // Body isn't JSON we can safely amend; fall through.
    }
  }
  return fetch(input, init);
};

/**
 * Pure helper: given a possibly-mangled tool name and the set of known tool
 * names, return the real tool name and the leftover (argument) string.
 */
export function splitMangledToolName(
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
