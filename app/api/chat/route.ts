import {
  convertToModelMessages,
  streamText,
  stepCountIs,
  type UIMessage,
} from "ai";
import { createGroq } from "@ai-sdk/groq";
import { createExaMcpClient } from "@/lib/exa-mcp";
import { DEFAULT_GROQ_MODEL, isValidGroqModel } from "@/lib/models";

// Allow the agentic search/crawl loop enough time to run.
export const maxDuration = 60;

const SYSTEM_PROMPT = `You are a meticulous web research assistant.

Your job is to answer the user's question using up-to-date information from the web.

Tools available to you:
- web_search_exa: search the web for a topic and get clean, ready-to-use content.
- web_search_advanced_exa: search with filters (domains, date ranges, categories) when you need precision.
- web_fetch_exa: read the full content of a specific URL as markdown. Use this to crawl promising results before answering.

Guidelines:
- For anything that depends on current events, facts, prices, docs, or specifics, ALWAYS search first instead of relying on memory.
- After searching, fetch the most relevant 1-3 sources with web_fetch_exa to read the actual content before answering non-trivial questions.
- Synthesize across sources. Do not just paste raw results.
- Cite your sources inline as markdown links, and end your answer with a "Sources" section listing the URLs you used.
- If the web does not have a clear answer, say so honestly.
- Be concise and well-structured. Use markdown (headings, lists) where it helps readability.`;

function errorHandler(error: unknown): string {
  if (error == null) return "Unknown error";
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return JSON.stringify(error);
}

export async function POST(req: Request) {
  if (!process.env.GROQ_API_KEY) {
    return Response.json(
      { error: "GROQ_API_KEY is not set on the server." },
      { status: 500 },
    );
  }
  if (!process.env.EXA_API_KEY) {
    return Response.json(
      { error: "EXA_API_KEY is not set on the server." },
      { status: 500 },
    );
  }

  const { messages, model }: { messages: UIMessage[]; model?: string } =
    await req.json();

  // Only allow models from our curated free-tier allowlist; otherwise fall back.
  const selectedModel = isValidGroqModel(model)
    ? model
    : (process.env.GROQ_MODEL ?? DEFAULT_GROQ_MODEL);

  const groq = createGroq({ apiKey: process.env.GROQ_API_KEY });
  const mcpClient = await createExaMcpClient();
  const tools = await mcpClient.tools();

  const result = streamText({
    model: groq(selectedModel),
    system: SYSTEM_PROMPT,
    messages: await convertToModelMessages(messages),
    tools,
    // Let the model search, crawl multiple pages, then synthesize.
    stopWhen: stepCountIs(10),
    onFinish: async () => {
      await mcpClient.close();
    },
    onError: async () => {
      await mcpClient.close();
    },
  });

  return result.toUIMessageStreamResponse({ onError: errorHandler });
}
