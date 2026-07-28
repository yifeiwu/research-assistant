import "server-only";
import type { ToolSet } from "ai";

export type ToolExecute = (...args: unknown[]) => Promise<unknown>;

/** Transforms a tool's `execute`, wrapping it with additional behavior. */
export type ToolMiddleware = (execute: ToolExecute, name: string) => ToolExecute;

/**
 * Apply middlewares to every executable tool's `execute` in a single pass over
 * the toolset. Middlewares are listed outermost-first: the first runs before the
 * second, which runs before the underlying tool. Tools without an `execute`
 * (rare for MCP tools) pass through untouched.
 */
export function wrapToolExecute(
  tools: ToolSet,
  ...middlewares: ToolMiddleware[]
): ToolSet {
  const wrapped: Record<string, unknown> = {};
  for (const [name, tool] of Object.entries(tools)) {
    const original = tool as { execute?: ToolExecute };
    if (typeof original.execute !== "function") {
      wrapped[name] = tool;
      continue;
    }
    let execute: ToolExecute = original.execute.bind(tool);
    for (let i = middlewares.length - 1; i >= 0; i--) {
      execute = middlewares[i](execute, name);
    }
    wrapped[name] = { ...tool, execute };
  }
  return wrapped as ToolSet;
}
