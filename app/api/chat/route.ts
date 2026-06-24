import {
  convertToModelMessages,
  streamText,
  stepCountIs,
  type LanguageModel,
  type UIMessage,
} from "ai";
import { createGroq } from "@ai-sdk/groq";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createExaMcpClient } from "@/lib/exa-mcp";
import { DEFAULT_GROQ_MODEL, isValidGroqModel } from "@/lib/models";
import { wrapToolsWithSummarizer } from "@/lib/pipeline";
import {
  isCustomProviderPayload,
  type CustomProviderPayload,
} from "@/lib/provider";
import {
  groqToolValidationFetch,
  repairMangledToolCall,
} from "@/lib/groq-tool-fix";
import {
  logInfo,
  logDebug,
  logError,
  extractFailedGeneration,
} from "@/lib/logger";

// Allow the agentic search/crawl loop enough time to run.
export const maxDuration = 60;

// Cheap, fast model used for the "map" step (per-page summarization).
const DEFAULT_SUMMARY_MODEL = "llama-3.1-8b-instant";

const SYSTEM_PROMPT = `You are a meticulous web research assistant.

Your job is to answer the user's question using up-to-date information from the web.

Tools available to you:
- web_search_exa: search the web for a topic and get clean, ready-to-use content.
- web_search_advanced_exa: search with filters (domains, date ranges, categories) when you need precision.
- web_fetch_exa: read the full content of a specific URL as markdown. Use this to crawl promising results before answering.

Note: tool results are automatically condensed into compact research notes (with their source URLs preserved) before you see them. Treat these notes as your evidence and cite their URLs.

Guidelines:
- For anything that depends on current events, facts, prices, docs, or specifics, ALWAYS search first instead of relying on memory.
- After searching, fetch the most relevant 1-3 sources with web_fetch_exa to read the actual content before answering non-trivial questions.
- Synthesize across sources. Do not just paste raw results.
- Cite your sources inline as markdown links, and end your answer with a "Sources" section listing the URLs you used.
- If the web does not have a clear answer, say so honestly.
- Be concise and well-structured. Use markdown (headings, lists) where it helps readability.`;

/** Extract the text of the most recent user message to focus summaries. */
function latestUserText(messages: UIMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "user") continue;
    return message.parts
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("\n")
      .trim();
  }
  return "";
}

/** Turn an error into a user-facing message, including Groq's failed_generation. */
function clientErrorMessage(error: unknown): string {
  let message = "Unknown error";
  if (typeof error === "string") message = error;
  else if (error instanceof Error) message = error.message;
  else if (error != null) message = JSON.stringify(error);

  const failed = extractFailedGeneration(error);
  if (failed) {
    const snippet = failed.length > 600 ? `${failed.slice(0, 600)}…` : failed;
    message += `\n\nModel output that failed to parse:\n${snippet}`;
  }
  return message;
}

/** Build the main (reduce) and summary (map) models for a custom endpoint. */
function buildCustomModels(payload: CustomProviderPayload): {
  mainModel: LanguageModel;
  summaryModel: LanguageModel;
} {
  const provider = createOpenAICompatible({
    name: "custom",
    baseURL: payload.baseURL,
    apiKey: payload.apiKey,
  });
  // Custom endpoints expose arbitrary models; use the chosen one for both steps.
  const model = provider(payload.model);
  return { mainModel: model, summaryModel: model };
}

export async function POST(req: Request) {
  if (!process.env.EXA_API_KEY) {
    return Response.json(
      { error: "EXA_API_KEY is not set on the server." },
      { status: 500 },
    );
  }

  const {
    messages,
    model,
    provider,
  }: { messages: UIMessage[]; model?: string; provider?: unknown } =
    await req.json();

  const requestId = crypto.randomUUID().slice(0, 8);
  const query = latestUserText(messages);

  let mainModel: LanguageModel;
  let summaryModel: LanguageModel;
  let modelInfo: string;

  if (isCustomProviderPayload(provider)) {
    ({ mainModel, summaryModel } = buildCustomModels(provider));
    modelInfo = `custom (${provider.baseURL}) ${provider.model}`;
  } else {
    if (!process.env.GROQ_API_KEY) {
      return Response.json(
        {
          error:
            "GROQ_API_KEY is not set on the server. Add it, or configure a custom OpenAI-compatible provider in Settings.",
        },
        { status: 500 },
      );
    }
    const groq = createGroq({
      apiKey: process.env.GROQ_API_KEY,
      // Work around Groq/Llama embedding tool args in the tool name.
      fetch: groqToolValidationFetch,
    });
    // Only allow models from our curated free-tier allowlist; otherwise fall back.
    const selectedModel = isValidGroqModel(model)
      ? model
      : (process.env.GROQ_MODEL ?? DEFAULT_GROQ_MODEL);
    mainModel = groq(selectedModel);
    // Map step: a cheap, fast model condenses each large tool result.
    summaryModel = groq(process.env.GROQ_SUMMARY_MODEL ?? DEFAULT_SUMMARY_MODEL);
    modelInfo = `groq ${selectedModel}`;
  }

  logInfo("request", {
    requestId,
    model: modelInfo,
    messageCount: messages.length,
    query: query.slice(0, 200),
  });

  const mcpClient = await createExaMcpClient();
  const tools = wrapToolsWithSummarizer(await mcpClient.tools(), {
    model: summaryModel,
    query,
    requestId,
  });
  logDebug("tools", { requestId, tools: Object.keys(tools) });

  const result = streamText({
    // Reduce step: the selected model synthesizes the condensed notes.
    model: mainModel,
    system: SYSTEM_PROMPT,
    messages: await convertToModelMessages(messages),
    tools,
    // Repair tool calls where the model glued JSON args onto the tool name.
    experimental_repairToolCall: repairMangledToolCall,
    // Let the model search, crawl multiple pages, then synthesize.
    stopWhen: stepCountIs(10),
    onStepFinish: ({ toolCalls, finishReason, usage }) => {
      logDebug("step", {
        requestId,
        finishReason,
        toolCalls: toolCalls?.map((c) => c.toolName),
        usage,
      });
    },
    onError: async ({ error }) => {
      logError("streamText", error, { requestId, model: modelInfo });
      await mcpClient.close();
    },
    onFinish: async ({ finishReason, usage, steps }) => {
      logInfo("finish", {
        requestId,
        finishReason,
        steps: steps.length,
        usage,
      });
      await mcpClient.close();
    },
  });

  return result.toUIMessageStreamResponse({
    onError: (error) => {
      logError("stream", error, { requestId, model: modelInfo });
      return clientErrorMessage(error);
    },
  });
}
