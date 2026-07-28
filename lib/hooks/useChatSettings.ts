"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_PROVIDER_SETTINGS,
  type ProviderSettings,
} from "@/lib/provider";
import type { ChatRequestBody } from "@/lib/types/chat";

const SETTINGS_STORAGE_KEY = "web-seek-settings";

export type ChatSettings = {
  settings: ProviderSettings;
  updateSettings: (next: ProviderSettings) => void;
  /**
   * Build the per-request body from the latest settings. Stable identity (reads
   * settings via a ref) so callbacks depending on it don't churn — which would
   * otherwise break Message memoization during streaming.
   */
  requestBody: () => ChatRequestBody;
};

/** Owns provider/model/effort settings and their localStorage persistence. */
export function useChatSettings(): ChatSettings {
  const [settings, setSettings] = useState<ProviderSettings>(
    DEFAULT_PROVIDER_SETTINGS,
  );

  const settingsRef = useRef(settings);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  // Restore provider settings.
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
      if (saved) {
        setSettings({ ...DEFAULT_PROVIDER_SETTINGS, ...JSON.parse(saved) });
      }
    } catch {
      // ignore malformed storage
    }
  }, []);

  const updateSettings = useCallback((next: ProviderSettings) => {
    setSettings(next);
    try {
      window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // ignore
    }
  }, []);

  const requestBody = useCallback((): ChatRequestBody => {
    const s = settingsRef.current;
    if (s.provider === "custom") {
      return {
        provider: {
          type: "custom",
          baseURL: s.customBaseURL.trim(),
          apiKey: s.customApiKey.trim(),
          model: s.customModel.trim(),
        },
        effort: s.effort,
      };
    }
    return { model: s.groqModel, effort: s.effort };
  }, []);

  return { settings, updateSettings, requestBody };
}
