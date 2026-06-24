import { createMCPClient } from "@ai-sdk/mcp";

const EXA_MCP_BASE_URL = "https://mcp.exa.ai/mcp";

// Tools to enable on the hosted Exa MCP server.
// - web_search_exa: semantic web search returning LLM-ready content
// - web_fetch_exa: read full page content (crawl) from known URLs as markdown
// - web_search_advanced_exa: search with domain/date/category filters
const EXA_TOOLS = [
  "web_search_exa",
  "web_fetch_exa",
  "web_search_advanced_exa",
].join(",");

/**
 * Creates an MCP client connected to Exa's hosted Search MCP server.
 * The Exa API key is sent as an `x-api-key` header so it never reaches the browser.
 */
export async function createExaMcpClient() {
  const apiKey = process.env.EXA_API_KEY;
  if (!apiKey) {
    throw new Error("EXA_API_KEY environment variable is not set.");
  }

  const url = `${EXA_MCP_BASE_URL}?tools=${EXA_TOOLS}`;

  return createMCPClient({
    transport: {
      type: "http",
      url,
      headers: { "x-api-key": apiKey },
    },
  });
}
