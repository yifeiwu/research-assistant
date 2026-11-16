"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { ActionButton } from "./ActionButton";

export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard may be unavailable; ignore
    }
  }

  return (
    <ActionButton
      label={copied ? "Copied" : "Copy answer"}
      icon={
        copied ? (
          <Check className="h-3.5 w-3.5" aria-hidden />
        ) : (
          <Copy className="h-3.5 w-3.5" aria-hidden />
        )
      }
      onClick={copy}
    />
  );
}
