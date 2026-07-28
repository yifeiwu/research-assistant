/**
 * Pull the human-readable text out of an MCP tool result, which is usually
 * shaped like `{ content: [{ type: 'text', text }] }`. Falls back to JSON for
 * anything that isn't recognizably an MCP text result.
 *
 * `pretty` controls the JSON fallback indentation: server-side callers keep it
 * compact, while the UI pretty-prints for readability.
 */
export function mcpOutputToText(
  output: unknown,
  opts: { pretty?: boolean } = {},
): string {
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
    return opts.pretty
      ? JSON.stringify(output, null, 2)
      : JSON.stringify(output);
  } catch {
    return String(output);
  }
}

/** The shape MCP tools return text results in. */
export type McpTextResult = { content: Array<{ type: "text"; text: string }> };

/** Wrap plain text back into the MCP text-result shape tools return. */
export function asTextResult(text: string): McpTextResult {
  return { content: [{ type: "text", text }] };
}
