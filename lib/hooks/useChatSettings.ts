"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_SETTINGS,
  sanitizeSettings,
  type AppSettings,
} from "@/lib/settings";
import type { ChatRequestBody } from "@/lib/types/chat";

const SETTINGS_STORAGE_KEY = "web-seek-settings";

export type ChatSettings = {
  settings: AppSettings;
  updateSettings: (next: AppSettings) => void;
  requestBody: () => ChatRequestBody;
};

/** Owns Groq model/effort settings and their localStorage persistence. */
export function useChatSettings(): ChatSettings {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const settingsRef = useRef(settings);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  // Restore settings, migrating legacy payloads by discarding any custom
  // provider fields (including a stored API key) and rewriting the clean copy.
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
      if (saved) {
        const cleaned = sanitizeSettings(JSON.parse(saved));
        setSettings(cleaned);
        window.localStorage.setItem(
          SETTINGS_STORAGE_KEY,
          JSON.stringify(cleaned),
        );
      }
    } catch {
      // ignore malformed storage
    }
  }, []);

  const updateSettings = useCallback((next: AppSettings) => {
    const cleaned = sanitizeSettings(next);
    setSettings(cleaned);
    try {
      window.localStorage.setItem(
        SETTINGS_STORAGE_KEY,
        JSON.stringify(cleaned),
      );
    } catch {
      // ignore
    }
  }, []);

  const requestBody = useCallback((): ChatRequestBody => {
    const s = settingsRef.current;
    return { model: s.model, effort: s.effort };
  }, []);

  return { settings, updateSettings, requestBody };
}
