"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { UIMessage } from "ai";
import { ToolStep, type DynamicToolPart } from "./ToolStep";

export function Message({ message }: { message: UIMessage }) {
  const isUser = message.role === "user";

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={
          isUser
            ? "max-w-[85%] rounded-2xl rounded-br-sm bg-accent px-4 py-2.5 text-white"
            : "w-full max-w-full"
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
              <div key={index} className="prose-chat leading-relaxed">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {part.text}
                </ReactMarkdown>
              </div>
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
      </div>
    </div>
  );
}
