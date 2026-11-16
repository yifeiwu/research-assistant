"use client";

import { useEffect, useRef, useState } from "react";
import type { ChatMessage } from "@/lib/types/chat";

export type ScrollAnchor = {
  scrollRef: React.RefObject<HTMLDivElement | null>;
  atBottom: boolean;
  handleScroll: () => void;
  scrollToBottom: () => void;
};

/**
 * Keep the message list pinned to the bottom as progress updates arrive, unless
 * the user has scrolled up to inspect earlier turns.
 */
export function useScrollAnchor(
  messages: ChatMessage[],
  isBusy: boolean,
): ScrollAnchor {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);

  useEffect(() => {
    if (!atBottom) return;
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: isBusy ? "auto" : "smooth",
    });
  }, [messages, atBottom, isBusy]);

  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setAtBottom(distanceFromBottom < 80);
  }

  function scrollToBottom() {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
    setAtBottom(true);
  }

  return { scrollRef, atBottom, handleScroll, scrollToBottom };
}
