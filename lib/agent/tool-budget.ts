import "server-only";
import { asTextResult } from "@/lib/mcp-output";
import type { ToolMiddleware } from "@/lib/agent/tool-middleware";

// Returned by a tool once the research budget is spent, in place of running the
// search/crawl. Shaped like an MCP text result so it flows through unchanged.
export const RESEARCH_BUDGET_SPENT_NOTE =
  "Research budget spent: the search and crawl tools are now disabled. Do not call them again. Write your final answer now from the research notes already gathered, citing the sources you have.";

export type ToolBudget = {
  limit: number;
  used: () => number;
  onUse: () => void;
};

/**
 * Tool middleware that enforces the tool-call budget WITHOUT removing tools from
 * the request.
 *
 * Disabling tools (activeTools: []) makes the Groq provider send a request with
 * no tools, so Groq applies its default `tool_choice: "none"` and then rejects
 * the whole request with a 400 ("Tool choice is none, but model called a tool")
 * whenever a gpt-oss/reasoning model emits a tool call anyway. Instead we keep
 * every tool callable (tool_choice stays "auto") and short-circuit execution
 * once the budget is spent, so real search/crawl calls are still capped.
 */
export function budgetMiddleware(budget: ToolBudget): ToolMiddleware {
  return (execute) =>
    async (...args) => {
      if (budget.used() >= budget.limit) {
        return asTextResult(RESEARCH_BUDGET_SPENT_NOTE);
      }
      budget.onUse();
      return execute(...args);
    };
}
