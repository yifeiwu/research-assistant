"use client";

import { useEffect, useRef, useState } from "react";
import type { UIMessage } from "ai";

export type ScrollAnchor = {
  scrollRef: React.RefObject<HTMLDivElement | null>;
  atBottom: boolean;
  handleScroll: () => void;
  scrollToBottom: () => void;
};

/**
 * Keep the message list pinned to the bottom while new content streams in, but
 * only when the user is already near the bottom, so scrolling up to read earlier
 * messages isn't interrupted.
 */
export function useScrollAnchor(
  messages: UIMessage[],
  isBusy: boolean,
): ScrollAnchor {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);

  // Only auto-scroll when the user is already near the bottom. During streaming
  // we jump instantly instead of animating: a smooth scroll fires on every
  // token and the overlapping animations cause visible jank.
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
