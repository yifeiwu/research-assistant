import "server-only";
import type { ToolSet } from "ai";
import { createExaMcpClient } from "@/lib/exa-mcp";
import { logError } from "@/lib/logger";

export type McpSession = {
  /** Raw Exa MCP tools, as discovered from the server. */
  tools: ToolSet;
  /**
   * Close the MCP connection exactly once, no matter which lifecycle callback
   * fires (finish / error / abort) or how many fire.
   */
  close: () => Promise<void>;
};

/**
 * Open an Exa MCP connection and discover its tools. If tool discovery throws,
 * the connection is closed before the error propagates so it never leaks.
 * Callers wrap the returned tools (budget + summarizer) via `wrapToolExecute`.
 */
export async function createMcpSession(opts: {
  requestId: string;
}): Promise<McpSession> {
  const client = await createExaMcpClient();

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      await client.close();
    } catch (error) {
      logError("mcp-close", error, { requestId: opts.requestId });
    }
  };

  try {
    const tools = await client.tools();
    return { tools, close };
  } catch (error) {
    await close();
    throw error;
  }
}
