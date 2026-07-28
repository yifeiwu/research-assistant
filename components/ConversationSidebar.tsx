"use client";

import { MessageSquarePlus, Settings2, Trash2, X } from "lucide-react";
import type { Conversation } from "@/lib/conversations";
import { currentModelLabel, type ProviderSettings } from "@/lib/provider";

export function ConversationSidebar({
  conversations,
  activeId,
  open,
  settings,
  onSelect,
  onNewChat,
  onDelete,
  onClose,
  onOpenSettings,
}: {
  conversations: Conversation[];
  activeId: string | null;
  open: boolean;
  settings: ProviderSettings;
  onSelect: (id: string) => void;
  onNewChat: () => void;
  onDelete: (id: string) => void;
  onClose: () => void;
  onOpenSettings: () => void;
}) {
  return (
    <>
      {/* Mobile backdrop */}
      {open && (
        <div
          className="fixed inset-0 z-20 bg-black/50 md:hidden"
          onClick={onClose}
          aria-hidden
        />
      )}

      <aside
        className={
          "z-30 flex h-full w-72 shrink-0 flex-col border-r border-border bg-surface transition-transform duration-200 " +
          "max-md:fixed max-md:inset-y-0 max-md:left-0 " +
          (open
            ? "translate-x-0"
            : "max-md:-translate-x-full md:hidden")
        }
        aria-label="Conversation history"
      >
        <div className="flex items-center justify-between gap-2 px-3 py-3">
          <span className="text-xs font-medium tracking-wide text-muted uppercase">
            History
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close history"
            className="flex h-10 w-10 items-center justify-center rounded-lg text-muted transition hover:bg-surface-2 hover:text-foreground md:hidden"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>

        <div className="px-3 pb-2">
          <button
            type="button"
            onClick={onNewChat}
            className="flex w-full items-center gap-2 rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-foreground transition hover:border-accent"
          >
            <MessageSquarePlus className="h-4 w-4" aria-hidden />
            New chat
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto px-2 py-2">
          {conversations.length === 0 ? (
            <p className="px-2 py-6 text-center text-xs text-muted">
              No saved conversations yet.
            </p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {conversations.map((conv) => {
                const active = conv.id === activeId;
                return (
                  <li key={conv.id}>
                    <div
                      className={
                        "group flex items-center gap-1 rounded-lg pr-1 transition " +
                        (active
                          ? "bg-accent/10"
                          : "hover:bg-surface-2")
                      }
                    >
                      <button
                        type="button"
                        onClick={() => onSelect(conv.id)}
                        className={
                          "flex-1 truncate px-3 py-2 text-left text-sm transition " +
                          (active
                            ? "text-foreground"
                            : "text-muted group-hover:text-foreground")
                        }
                        title={conv.title}
                      >
                        {conv.title}
                      </button>
                      <button
                        type="button"
                        onClick={() => onDelete(conv.id)}
                        aria-label={`Delete "${conv.title}"`}
                        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-muted opacity-100 transition hover:bg-border hover:text-red-400 focus:opacity-100 md:h-7 md:w-7 md:opacity-0 md:group-hover:opacity-100"
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden />
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </nav>

        <div className="border-t border-border p-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))]">
          <button
            type="button"
            onClick={onOpenSettings}
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-muted transition hover:bg-surface-2 hover:text-foreground"
          >
            <Settings2 className="h-4 w-4 shrink-0" aria-hidden />
            <span className="flex min-w-0 flex-col">
              <span className="text-xs text-muted">Model &amp; provider</span>
              <span className="truncate text-foreground">
                {currentModelLabel(settings)}
              </span>
            </span>
          </button>
          <p className="px-3 pt-1 text-[11px] text-muted/70">
            powered by Groq + Exa
          </p>
        </div>
      </aside>
    </>
  );
}
