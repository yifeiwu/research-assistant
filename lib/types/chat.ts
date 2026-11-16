import { z } from "zod";

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
  | "reading"
  | "checking-gaps"
  | "done"
  | "error";

/** Human-readable reasons when part of a research round degraded. */
export type DegradedResearch = string[];

/** State of a single deterministic research round. */
export type ResearchStepData = {
  round: number;
  phase: ResearchStepPhase;
  query?: string;
  sources: ResearchSource[];
  notes?: string;
  error?: string;
  degraded?: DegradedResearch;
};

/** Plain JSON chat message persisted in Redis and localStorage. */
export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  reasoning?: string;
  steps?: ResearchStepData[];
  sources?: ResearchSource[];
};

/** Why an active turn is currently waiting before its next step. */
export type TurnWaitState =
  | { kind: "queued"; position: number }
  | {
      kind: "rate-limit";
      stage: "planning" | "reading" | "answering";
      resumeAt: number;
    };

/** Durable server-side state of a chat turn stored in Upstash Redis. */
export type DurableTurnState = {
  runId: string;
  chatId: string;
  turnId?: string;
  status: "running" | "done" | "stopped" | "error";
  steps: ResearchStepData[];
  sources: ResearchSource[];
  wait?: TurnWaitState;
  message?: ChatMessage;
  error?: string;
  updatedAt: number;
};

const MAX_MESSAGES = 200;
const MAX_TOTAL_MESSAGE_CHARS = 500_000;

const chatMessageSchema = z.object({
  id: z.string().min(1).max(120),
  role: z.enum(["user", "assistant"]),
  text: z.string(),
});

export const chatRequestSchema = z
  .object({
    messages: z.array(chatMessageSchema).min(1).max(MAX_MESSAGES),
    id: z
      .string()
      .regex(CHAT_ID_REGEX, "id must be 8-80 word characters or hyphens")
      .optional(),
    effort: z.unknown().optional(),
  })
  .refine(
    (body) => JSON.stringify(body.messages).length <= MAX_TOTAL_MESSAGE_CHARS,
    {
      message: `Message history is too large (max ${MAX_TOTAL_MESSAGE_CHARS} characters).`,
      path: ["messages"],
    },
  );
