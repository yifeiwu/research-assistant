import { z } from "zod";
import type { UIMessage } from "ai";
import type { EffortLevel } from "@/lib/effort";

/** A single web source retrieved during deterministic research. */
export type ResearchSource = {
  url: string;
  title?: string;
  publishedDate?: string;
};

/** Live phases for a deterministic research round rendered in the UI. */
export type ResearchStepPhase =
  | "planning"
  | "searching"
  | "reranking"
  | "reading"
  | "checking-gaps"
  | "synthesizing"
  | "done"
  | "error";

/** Structured evidence-quality signal when part of a research round failed. */
export type DegradedResearch = {
  failedQueries: string[];
  failedContents: boolean;
  fallbackSources: number;
  /** Human-readable failures of non-retrieval stages (planning, gap check). */
  failedStages?: string[];
  messages: string[];
};

/** Payload carried by a `data-research-step` UI message part. */
export type ResearchStepData = {
  round: number;
  phase: ResearchStepPhase;
  query?: string;
  sources: ResearchSource[];
  notes?: string;
  error?: string;
  degraded?: DegradedResearch;
};

/** Payload carried by a `data-model-fallback` UI message part when synthesis auto-switches models. */
export type ModelFallbackData = {
  fromModel: string;
  toModel: string;
  fromLabel: string;
  toLabel: string;
};

/**
 * Payload carried by the `data-turn-status` UI message part: why a turn is
 * not making visible progress right now. One part per turn, replaced in
 * place; `clear` means the turn is running again.
 */
export type TurnStatusData =
  /** Waiting for a free research slot; `position` is 1-based. */
  | { state: "queued"; position: number }
  /** Waiting for a model's per-minute rate-limit window. `resumeAt` is epoch ms. */
  | {
      state: "waiting";
      stage: "planning" | "reading" | "answering";
      modelLabel: string;
      resumeAt: number;
    }
  | { state: "clear" };

/** Custom AI SDK v6 data parts emitted by `/api/chat`. */
export type ChatDataParts = {
  "research-step": ResearchStepData;
  "model-fallback": ModelFallbackData;
  "turn-status": TurnStatusData;
};

/** Application UIMessage type with typed research-step data parts. */
export type ChatUIMessage = UIMessage<unknown, ChatDataParts>;

/**
 * The `/api/chat` request contract, shared between the client (which builds the
 * body) and the server route (which validates and consumes it).
 */
export type ChatRequest = {
  messages: UIMessage[];
  /** Conversation id; used to resume a generation after the client disconnects. */
  id?: string;
  model?: string;
  effort?: EffortLevel;
};

/**
 * The part of {@link ChatRequest} the client contributes as the extra request
 * body; `messages` is supplied by the `useChat` transport itself.
 */
export type ChatRequestBody = Omit<ChatRequest, "messages">;

/**
 * Upper bounds on the request payload. These guard against unbounded histories
 * (context blowups / memory pressure) and malformed clients; normal usage stays
 * well under them. `pruneAssistantHistory` already trims prior research payloads, so
 * the character cap mostly bounds pathological inputs.
 */
const MAX_MESSAGES = 200;
const MAX_TOTAL_MESSAGE_CHARS = 500_000;

/**
 * A single message part. We only assert the discriminating `type` field and
 * keep every other key (`text`, `data`, `url`, etc.) via `looseObject`, since
 * the downstream AI SDK reads those fields directly.
 */
const messagePartSchema = z.looseObject({
  type: z.string(),
});

/**
 * Structural validation for a UI message. The shape is intentionally close to
 * the AI SDK's `UIMessage`, but unknown keys are preserved so nothing the SDK
 * relies on is stripped before it runs.
 */
const uiMessageSchema = z.looseObject({
  role: z.enum(["system", "user", "assistant"]),
  parts: z.array(messagePartSchema),
});

/**
 * Structural validation for the request body. `messages` must be a non-empty
 * array of well-formed UI messages within the size caps; `effort` is left
 * loose here and coerced downstream by `effortConfig`. Unknown keys (such as
 * a legacy `provider` from an old cached client) are stripped by Zod.
 */
export const chatRequestSchema = z
  .object({
    messages: z.array(uiMessageSchema).min(1).max(MAX_MESSAGES),
    // Must match `isChatId` in lib/agent/chat-stream: an id outside this
    // alphabet can never address a Redis stream, so reject it with a 400
    // here instead of silently running an unresumable generation.
    id: z
      .string()
      .regex(/^[\w-]{8,80}$/, "id must be 8-80 word characters or hyphens")
      .optional(),
    model: z.string().optional(),
    effort: z.unknown().optional(),
  })
  .refine(
    (body) => JSON.stringify(body.messages).length <= MAX_TOTAL_MESSAGE_CHARS,
    {
      message: `Message history is too large (max ${MAX_TOTAL_MESSAGE_CHARS} characters).`,
      path: ["messages"],
    },
  );
