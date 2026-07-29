import "server-only";
import { asTextResult } from "@/lib/mcp-output";
import { logError } from "@/lib/logger";
import type { ToolMiddleware } from "@/lib/agent/tool-middleware";

/**
 * Tool middleware that converts a thrown tool failure into a text *result* the
 * model can read, instead of letting it bubble up and end the whole turn.
 *
 * Search/crawl calls fail mid-loop for lots of reasons: an Exa MCP transport
 * error, a dropped connection, or the per-tool timeout in `lib/pipeline.ts`
 * (which throws on purpose). Without this, such a throw propagates out of the
 * agent loop and the user's turn dies — even though the model could have simply
 * tried a different source or answered from the notes it already gathered. By
 * returning the failure as a normal tool result, the model stays in control and
 * degrades gracefully.
 *
 * Client aborts (the user hits Stop / navigates away) are re-thrown untouched so
 * the request tears down normally rather than being masked as a tool result.
 *
 * Place this OUTSIDE the summarizer middleware so it also catches the per-tool
 * timeout that the summarizer throws.
 */
export function resilientToolMiddleware(opts: {
  requestId?: string;
}): ToolMiddleware {
  return (execute, name) =>
    async (...args) => {
      try {
        return await execute(...args);
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw error;

        logError("tool-execute", error, {
          requestId: opts.requestId,
          tool: name,
          errorClass: "tool_failure",
        });

        const reason = error instanceof Error ? error.message : String(error);
        return asTextResult(
          `The ${name} tool failed and returned no result (${reason}). ` +
            `Do not retry this exact call. Either try a different query or source, ` +
            `or write your answer now using the research notes you already have, ` +
            `noting any gaps caused by the failed lookup.`,
        );
      }
    };
}
