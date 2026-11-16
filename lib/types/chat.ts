import { z } from "zod";
import type { UIMessage } from "ai";
import type { EffortLevel } from "@/lib/effort";

export const CHAT_ID_REGEX = /^[\w-]{8,80}$/;

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

/** Human-readable reasons when part of a research round degraded. */
export type DegradedResearch = string[];

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
 * well under them.
 */
const MAX_MESSAGES = 200;
const MAX_TOTAL_MESSAGE_CHARS = 500_000;

const messagePartSchema = z.looseObject({
  type: z.string(),
});

const uiMessageSchema = z.looseObject({
  role: z.enum(["system", "user", "assistant"]),
  parts: z.array(messagePartSchema),
});

export const chatRequestSchema = z
  .object({
    messages: z.array(uiMessageSchema).min(1).max(MAX_MESSAGES),
    id: z
      .string()
      .regex(CHAT_ID_REGEX, "id must be 8-80 word characters or hyphens")
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
