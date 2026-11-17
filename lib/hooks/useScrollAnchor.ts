"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatMessage } from "@/lib/types/chat";

export type ScrollAnchor = {
  scrollRef: React.RefObject<HTMLDivElement | null>;
  atBottom: boolean;
  handleScroll: () => void;
  scrollToBottom: () => void;
};

/**
 * Keep the message list pinned to the bottom as messages and live research
 * steps arrive, unless the user has scrolled up to inspect earlier turns.
 */
export function useScrollAnchor(
  messages: ChatMessage[],
  isBusy: boolean,
  liveStepCount: number = 0,
  activeId?: string,
): ScrollAnchor {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const prevActiveIdRef = useRef(activeId);

  useEffect(() => {
    if (prevActiveIdRef.current !== activeId) {
      prevActiveIdRef.current = activeId;
      queueMicrotask(() => {
        setAtBottom(true);
        scrollRef.current?.scrollTo({
          top: scrollRef.current.scrollHeight,
          behavior: "auto",
        });
      });
      return;
    }
    if (!atBottom) return;
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: isBusy ? "auto" : "smooth",
    });
  }, [activeId, messages, liveStepCount, atBottom, isBusy]);

  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setAtBottom(distanceFromBottom < 80);
  }

  const scrollToBottom = useCallback(() => {
    setAtBottom(true);
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({
        top: scrollRef.current.scrollHeight,
        behavior: "smooth",
      });
    });
  }, []);

  return { scrollRef, atBottom, handleScroll, scrollToBottom };
}
