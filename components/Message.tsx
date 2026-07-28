"use client";

import { memo, useMemo, useState } from "react";
import type { UIMessage } from "ai";
import { Pencil, RotateCcw } from "lucide-react";
import { ToolStep, type DynamicToolPart } from "./ToolStep";
import { Markdown } from "./Markdown";
import { collectSources } from "@/lib/sources";
import { getMessageText } from "@/lib/messages";
import { ActionButton } from "./message/ActionButton";
import { CopyButton } from "./message/CopyButton";
import { EditUserMessage } from "./message/EditUserMessage";
import { Reasoning } from "./message/Reasoning";
import { SourcesBar } from "./message/SourcesBar";

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

            if (part.type === "dynamic-tool") {
              return <ToolStep key={index} part={part as DynamicToolPart} />;
            }

            if (part.type === "step-start") {
              return index > 0 ? (
                <hr key={index} className="my-3 border-border/60" />
              ) : null;
            }

            return null;
          })}

          {!isUser && streaming && (
            <span
              className="stream-caret ml-0.5 inline-block h-4 w-[2px] translate-y-0.5 bg-accent align-middle"
              aria-hidden
            />
          )}

          {!isUser && sources.length > 0 && <SourcesBar sources={sources} />}
        </div>

        {/* Row of message actions, revealed on hover. */}
        {isUser && onEdit && (
          <div className="mt-1 flex justify-end opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">
            <ActionButton
              label="Edit"
              icon={<Pencil className="h-3.5 w-3.5" aria-hidden />}
              onClick={() => setEditing(true)}
            />
          </div>
        )}

        {!isUser && !streaming && answerText.length > 0 && (
          <div className="mt-2 flex items-center justify-end gap-1 opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">
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
