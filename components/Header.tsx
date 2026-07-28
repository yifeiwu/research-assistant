"use client";

import { PanelLeft } from "lucide-react";
import { Logo } from "./Logo";

export function Header({
  onNewChat,
  onToggleSidebar,
}: {
  onNewChat: () => void;
  onToggleSidebar: () => void;
}) {
  return (
    <header className="flex items-center gap-2 border-b border-border px-3 py-3 sm:px-5">
      <button
        type="button"
        onClick={onToggleSidebar}
        aria-label="Toggle conversation history"
        className="flex h-10 w-10 items-center justify-center rounded-lg border border-border bg-surface text-muted transition hover:border-accent hover:text-foreground md:h-8 md:w-8"
      >
        <PanelLeft className="h-4 w-4" aria-hidden />
      </button>
      <button
        type="button"
        onClick={onNewChat}
        aria-label="Go to home"
        title="Home"
        className="flex items-center gap-2 rounded-lg px-1 py-0.5 transition hover:opacity-80"
      >
        <Logo className="h-5 w-5 text-accent" />
        <h1 className="text-base font-semibold tracking-tight">
          Web Seek
        </h1>
      </button>
    </header>
  );
}
