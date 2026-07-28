"use client";

import { useRef, useState } from "react";
import { X } from "lucide-react";

export function EditUserMessage({
  initial,
  onSave,
  onCancel,
}: {
  initial: string;
  onSave: (text: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);

  return (
    <div className="flex justify-end">
      <div className="w-full max-w-[85%] rounded-2xl border border-accent bg-surface p-2">
        <textarea
          ref={ref}
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (value.trim()) onSave(value.trim());
            }
            if (e.key === "Escape") onCancel();
          }}
          rows={2}
          className="max-h-52 w-full resize-none bg-transparent px-2 py-1.5 text-foreground outline-none"
        />
        <div className="mt-1 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs text-muted transition hover:bg-surface-2 hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" aria-hidden />
            Cancel
          </button>
          <button
            type="button"
            disabled={!value.trim()}
            onClick={() => onSave(value.trim())}
            className="rounded-lg bg-accent px-3 py-1 text-xs font-medium text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Save &amp; resend
          </button>
        </div>
      </div>
    </div>
  );
}
