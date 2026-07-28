import { z } from "zod";
import type { UIMessage } from "ai";
import type { CustomProviderPayload } from "@/lib/provider";
import type { EffortLevel } from "@/lib/effort";

/**
 * The `/api/chat` request contract, shared between the client (which builds the
 * body) and the server route (which validates and consumes it).
 */
export type ChatRequest = {
  messages: UIMessage[];
  model?: string;
  provider?: CustomProviderPayload;
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
 * well under them. `pruneToolHistory` already trims prior tool payloads, so the
 * character cap mostly bounds pathological inputs.
 */
export const MAX_MESSAGES = 200;
export const MAX_TOTAL_MESSAGE_CHARS = 500_000;

/**
 * A single message part. We only assert the discriminating `type` field and
 * keep every other key (`text`, tool-call ids/inputs/outputs, etc.) via
 * `looseObject`, since the downstream AI SDK reads those fields directly.
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
 * array of well-formed UI messages within the size caps; `provider` and
 * `effort` are left loose here and coerced downstream by
 * `isCustomProviderPayload` / `effortConfig`, which already tolerate unknown
 * input and fall back to safe defaults.
 */
export const chatRequestSchema = z
  .object({
    messages: z.array(uiMessageSchema).min(1).max(MAX_MESSAGES),
    model: z.string().optional(),
    provider: z.unknown().optional(),
    effort: z.unknown().optional(),
  })
  .refine((body) => JSON.stringify(body.messages).length <= MAX_TOTAL_MESSAGE_CHARS, {
    message: `Message history is too large (max ${MAX_TOTAL_MESSAGE_CHARS} characters).`,
    path: ["messages"],
  });
