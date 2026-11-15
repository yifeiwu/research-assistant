"use client";

import { memo, useMemo, useState } from "react";
import type { UIMessage } from "ai";
import { Pencil, RotateCcw } from "lucide-react";
import { ResearchStep } from "./ResearchStep";
import { Markdown } from "./Markdown";
import { collectSources, splitSourcesByCitation } from "@/lib/sources";
import { getMessageText } from "@/lib/messages";
import type { ModelFallbackData, ResearchStepData } from "@/lib/types/chat";
import { ActionButton } from "./message/ActionButton";
import { CopyButton } from "./message/CopyButton";
import { EditUserMessage } from "./message/EditUserMessage";
import { Reasoning } from "./message/Reasoning";
import { SourcesBar } from "./message/SourcesBar";
import { TurnStatus } from "./message/TurnStatus";
import { activeTurnStatus } from "@/lib/turn-status";

export const Message = memo(function Message({
  message,
  streaming = false,
  onEdit,
  onRegenerate,
}: {
  message: UIMessage;
  streaming?: boolean;
  onEdit?: (id: string, newText: string) => void;
  onRegenerate?: (id: string) => void;
}) {
  const isUser = message.role === "user";
  const [editing, setEditing] = useState(false);

  const answerText = useMemo(() => getMessageText(message).trim(), [message]);

  const sources = useMemo(
    () => (isUser ? [] : collectSources(message)),
    [isUser, message],
  );
  // Sorted into cited and not only once the answer is complete, so the list
  // does not rearrange itself while links are still arriving.
  const { cited, other } = useMemo(
    () =>
      streaming
        ? { cited: [], other: sources }
        : splitSourcesByCitation(message, sources),
    [streaming, message, sources],
  );

  // Only a live turn can be queued or waiting; a stale status left in a
  // stopped or saved message is ignored.
  const turnStatus = useMemo(
    () => (!isUser && streaming ? activeTurnStatus(message) : null),
    [isUser, streaming, message],
  );

  if (isUser && editing) {
    return (
      <EditUserMessage
        initial={answerText}
        onCancel={() => setEditing(false)}
        onSave={(text) => {
          setEditing(false);
          onEdit?.(message.id, text);
        }}
      />
    );
  }

  return (
    <div className={`group flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={
          isUser
            ? "flex max-w-[85%] flex-col items-end"
            : "w-full max-w-full"
        }
      >
        <div
          className={
            isUser
              ? "rounded-2xl rounded-br-sm bg-accent px-4 py-2.5 text-white"
              : "w-full"
          }
        >
          {message.parts.map((part, index) => {
            if (part.type === "text") {
              if (isUser) {
                return (
                  <span key={index} className="whitespace-pre-wrap">
                    {part.text}
                  </span>
                );
              }
              return (
                <Markdown key={index} className="prose-chat leading-relaxed">
                  {part.text}
                </Markdown>
              );
            }

            if (part.type === "reasoning") {
              const text = (part as { text?: string }).text ?? "";
              if (!text.trim()) return null;
              const isStreaming =
                (part as { state?: string }).state === "streaming";
              return (
                <Reasoning key={index} text={text} streaming={isStreaming} />
              );
            }

            if (part.type === "data-research-step") {
              const dataPart = part as {
                id?: string;
                data?: ResearchStepData;
              };
              if (!dataPart.data) return null;
              return (
                <ResearchStep
                  key={dataPart.id ?? index}
                  data={dataPart.data}
                />
              );
            }

            if (part.type === "data-model-fallback") {
              const dataPart = part as {
                id?: string;
                data?: ModelFallbackData;
              };
              if (!dataPart.data) return null;
              return (
                <div
                  key={dataPart.id ?? index}
                  className="my-2 inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface-2/60 px-2.5 py-1 text-xs text-muted"
                >
                  <span>
                    Answered with{" "}
                    <span className="font-medium text-foreground">
                      {dataPart.data.toLabel}
                    </span>{" "}
                    ({dataPart.data.fromLabel} was rate-limited)
                  </span>
                </div>
              );
            }

            if (part.type === "step-start") {
              return index > 0 ? (
                <hr key={index} className="my-3 border-border/60" />
              ) : null;
            }

            return null;
          })}

          {turnStatus && (
            <div>
              <TurnStatus status={turnStatus} />
            </div>
          )}

          {!isUser && streaming && (
            <span
              className="stream-caret ml-0.5 inline-block h-4 w-[2px] translate-y-0.5 bg-accent align-middle"
              aria-hidden
            />
          )}

          {!isUser && sources.length > 0 && (
            <SourcesBar cited={cited} other={other} />
          )}
        </div>

        {/* Row of message actions, revealed on hover. */}
        {isUser && onEdit && (
          <div className="mt-1 flex justify-end opacity-100 transition md:opacity-0 md:group-hover:opacity-100 md:focus-within:opacity-100">
            <ActionButton
              label="Edit"
              icon={<Pencil className="h-3.5 w-3.5" aria-hidden />}
              onClick={() => setEditing(true)}
            />
          </div>
        )}

        {!isUser && !streaming && answerText.length > 0 && (
          <div className="mt-2 flex items-center justify-end gap-1 opacity-100 transition md:opacity-0 md:group-hover:opacity-100 md:focus-within:opacity-100">
            <CopyButton text={answerText} />
            {onRegenerate && (
              <ActionButton
                label="Regenerate"
                icon={<RotateCcw className="h-3.5 w-3.5" aria-hidden />}
                onClick={() => onRegenerate(message.id)}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
});
