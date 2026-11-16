"use client";

import { memo, useMemo, useState } from "react";
import { Pencil, RotateCcw } from "lucide-react";
import { ResearchStep } from "./ResearchStep";
import { Markdown } from "./Markdown";
import { collectSources, splitSourcesByCitation } from "@/lib/sources";
import type { ChatMessage } from "@/lib/types/chat";
import { ActionButton } from "./message/ActionButton";
import { CopyButton } from "./message/CopyButton";
import { EditUserMessage } from "./message/EditUserMessage";
import { Reasoning } from "./message/Reasoning";
import { SourcesBar } from "./message/SourcesBar";

export const Message = memo(function Message({
  message,
  onEdit,
  onRegenerate,
}: {
  message: ChatMessage;
  onEdit?: (id: string, newText: string) => void;
  onRegenerate?: (id: string) => void;
}) {
  const isUser = message.role === "user";
  const [editing, setEditing] = useState(false);
  const answerText = message.text.trim();

  const sources = useMemo(
    () => (isUser ? [] : collectSources(message)),
    [isUser, message],
  );
  const { cited, other } = useMemo(
    () => splitSourcesByCitation(message, sources),
    [message, sources],
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
          {!isUser &&
            message.steps?.map((step) => (
              <ResearchStep key={step.round} data={step} />
            ))}

          {!isUser && message.reasoning?.trim() && (
            <Reasoning text={message.reasoning} />
          )}

          {answerText.length > 0 &&
            (isUser ? (
              <span className="whitespace-pre-wrap">{message.text}</span>
            ) : (
              <Markdown className="prose-chat leading-relaxed">
                {message.text}
              </Markdown>
            ))}

          {!isUser && sources.length > 0 && (
            <SourcesBar cited={cited} other={other} />
          )}
        </div>

        {isUser && onEdit && (
          <div className="mt-1 flex justify-end opacity-100 transition md:opacity-0 md:group-hover:opacity-100 md:focus-within:opacity-100">
            <ActionButton
              label="Edit"
              icon={<Pencil className="h-3.5 w-3.5" aria-hidden />}
              onClick={() => setEditing(true)}
            />
          </div>
        )}

        {!isUser && answerText.length > 0 && (
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
