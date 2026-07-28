import {
  convertToModelMessages,
  streamText,
  stepCountIs,
  type UIMessage,
} from "ai";
import type { GroqProviderOptions } from "@ai-sdk/groq";
import { effortConfig } from "@/lib/effort";
import { chatRequestSchema } from "@/lib/types/chat";
import { latestUserText, pruneToolHistory } from "@/lib/messages";
import { buildSystemPrompt, buildFinalAnswerPrompt } from "@/lib/prompts";
import { repairMangledToolCall } from "@/lib/groq-tool-fix";
import { logInfo, logDebug, logError } from "@/lib/logger";
import { resolveModels, isResolutionError } from "@/lib/agent/models";
import { createMcpSession, type McpSession } from "@/lib/agent/mcp-lifecycle";
import { budgetMiddleware } from "@/lib/agent/tool-budget";
import { wrapToolExecute } from "@/lib/agent/tool-middleware";
import { summarizeMiddleware } from "@/lib/pipeline";
import { streamWithEmptyAnswerFallback } from "@/lib/agent/stream";

// Allow the agentic search/crawl loop enough time to run. Vercel Functions on
// Fluid compute (default) allow up to 300s on all plans, and active-CPU billing
// pauses while waiting on model/tool I/O, so a longer budget is cheap here.
export const maxDuration = 300;

export async function POST(req: Request) {
  if (!process.env.EXA_API_KEY) {
    return Response.json(
      { error: "EXA_API_KEY is not set on the server." },
      { status: 500 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Request body must be JSON." }, { status: 400 });
  }

  const parsed = chatRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid request body.", details: parsed.error.issues },
      { status: 400 },
    );
  }

  const { model, provider, effort } = parsed.data;
  const messages = parsed.data.messages as unknown as UIMessage[];

  const requestId = crypto.randomUUID().slice(0, 8);
  const query = latestUserText(messages);

  // Resolve the per-request agent step / tool-call budgets from the effort
  // level, and build the prompts (which reference the tool-call budget).
  const { maxSteps, maxToolCalls } = effortConfig(effort);
  const systemPrompt = buildSystemPrompt(maxToolCalls);
  const finalAnswerPrompt = buildFinalAnswerPrompt(maxToolCalls);

  const resolved = resolveModels({ model, provider });
  if (isResolutionError(resolved)) {
    return Response.json(
      { error: resolved.error },
      { status: resolved.status },
    );
  }
  const { mainModel, summaryModel, modelInfo, supportsReasoning } = resolved;

  logInfo("request", {
    requestId,
    model: modelInfo,
    messageCount: messages.length,
    query: query.slice(0, 200),
    maxSteps,
    maxToolCalls,
  });

  // Low effort (maxToolCalls === 0) never searches the web, so skip opening the
  // Exa MCP connection entirely rather than paying for a handshake just to gate
  // every call away. Otherwise open it, but treat a failed handshake as a clean
  // 502 instead of letting it escape as an unhandled 500.
  let mcp: McpSession = { tools: {}, close: async () => {} };
  if (maxToolCalls > 0) {
    try {
      mcp = await createMcpSession({ requestId });
    } catch (error) {
      logError("mcp-open", error, { requestId, model: modelInfo });
      return Response.json(
        {
          error:
            "Couldn't connect to the web search service. Please try again in a moment.",
        },
        { status: 502 },
      );
    }
  }
  logDebug("tools", { requestId, tools: Object.keys(mcp.tools) });

  // Track real (non-refused) tool calls so we can both refuse further calls
  // once the budget is spent and steer the model toward its final answer.
  // The budget middleware is outermost (runs first): once spent it short-circuits
  // before the summarizer "map" step ever executes the underlying tool.
  let toolCallsUsed = 0;
  const budgetedTools = wrapToolExecute(
    mcp.tools,
    budgetMiddleware({
      limit: maxToolCalls,
      used: () => toolCallsUsed,
      onUse: () => {
        toolCallsUsed += 1;
      },
    }),
    summarizeMiddleware({ model: summaryModel, query, requestId }),
  );

  const result = streamText({
    // Reduce step: the selected model synthesizes the condensed notes.
    model: mainModel,
    system: systemPrompt,
    messages: await convertToModelMessages(pruneToolHistory(messages)),
    tools: budgetedTools,
    // Surface reasoning models' thinking as separate reasoning parts. Only
    // reasoning models accept `reasoning_format`; sending it to a non-reasoning
    // Groq model (e.g. Llama) fails with a 400, so gate it on the model.
    providerOptions: supportsReasoning
      ? { groq: { reasoningFormat: "parsed" } satisfies GroqProviderOptions }
      : undefined,
    // Repair tool calls where the model glued JSON args onto the tool name.
    experimental_repairToolCall: repairMangledToolCall,
    // Let the model search, crawl multiple pages, then synthesize.
    stopWhen: stepCountIs(maxSteps),
    // Once the model has used its last allowed step or spent its search/crawl
    // budget, steer it to write an answer now. We intentionally keep the tools
    // active (they refuse via budgetMiddleware) rather than disabling them, since
    // disabling them makes Groq 400 with "Tool choice is none, but model called
    // a tool" (see lib/agent/tool-budget.ts).
    // Only steer toward a final answer when the model actually has a tool
    // budget; at 0 (low effort) the base prompt already tells it not to use
    // tools, so the "budget spent" framing would be contradictory.
    prepareStep: ({ stepNumber }) => {
      if (
        maxToolCalls > 0 &&
        (stepNumber >= maxSteps - 1 || toolCallsUsed >= maxToolCalls)
      ) {
        return { system: finalAnswerPrompt };
      }
      return {};
    },
    // Prevent the request from hanging forever when the model stalls after
    // tool calls complete. totalMs caps the whole request, kept under
    // `maxDuration` (300s) with margin so we return gracefully before Vercel
    // issues a hard FUNCTION_INVOCATION_TIMEOUT. stepMs caps a single step,
    // which includes both the model call AND that step's tool execution (so it
    // must exceed how long a search/crawl step can reasonably take).
    // (chunkMs is intentionally omitted: tool execution makes the model stream
    // go quiet for a while, which would otherwise trip a chunk-gap timeout.)
    timeout: { totalMs: 290_000, stepMs: 120_000 },
    // Abort if the client disconnects (e.g. user hits Stop or navigates away).
    abortSignal: req.signal,
    onStepFinish: ({ toolCalls, finishReason, usage }) => {
      logDebug("step", {
        requestId,
        finishReason,
        toolCalls: toolCalls?.map((c) => c.toolName),
        usage,
      });
    },
    onAbort: async () => {
      logInfo("abort", { requestId, model: modelInfo });
      await mcp.close();
    },
    onError: async ({ error }) => {
      logError("streamText", error, { requestId, model: modelInfo });
      await mcp.close();
    },
    onFinish: async ({ finishReason, usage, steps }) => {
      logInfo("finish", {
        requestId,
        finishReason,
        steps: steps.length,
        usage,
      });
      await mcp.close();
    },
  });

  return streamWithEmptyAnswerFallback(result, { requestId, modelInfo });
}
