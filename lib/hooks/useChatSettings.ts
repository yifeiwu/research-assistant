"use client";

import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import {
  DEFAULT_SETTINGS,
  sanitizeSettings,
  type AppSettings,
} from "@/lib/settings";
import type { ChatRequestBody } from "@/lib/types/chat";

const SETTINGS_STORAGE_KEY = "web-seek-settings";

const listeners = new Set<() => void>();
let cachedRaw: string | null | undefined;
let cachedSettings: AppSettings = DEFAULT_SETTINGS;

function readSettingsSnapshot(): AppSettings {
  try {
    const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (raw !== cachedRaw) {
      cachedRaw = raw;
      cachedSettings = raw ? sanitizeSettings(JSON.parse(raw)) : DEFAULT_SETTINGS;
    }
  } catch {
    cachedSettings = DEFAULT_SETTINGS;
  }
  return cachedSettings;
}

function getServerSnapshot(): AppSettings {
  return DEFAULT_SETTINGS;
}

function subscribeSettings(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (e: StorageEvent) => {
    if (e.key === SETTINGS_STORAGE_KEY) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export type ChatSettings = {
  settings: AppSettings;
  updateSettings: (next: AppSettings) => void;
  requestBody: () => ChatRequestBody;
};

/** Owns Groq model/effort settings and their localStorage persistence. */
export function useChatSettings(): ChatSettings {
  const settings = useSyncExternalStore(
    subscribeSettings,
    readSettingsSnapshot,
    getServerSnapshot,
  );
  const settingsRef = useRef(settings);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  const updateSettings = useCallback((next: AppSettings) => {
    const cleaned = sanitizeSettings(next);
    const serialized = JSON.stringify(cleaned);
    cachedRaw = serialized;
    cachedSettings = cleaned;
    try {
      window.localStorage.setItem(SETTINGS_STORAGE_KEY, serialized);
    } catch {
      // ignore quota/storage errors
    }
    for (const listener of listeners) listener();
  }, []);

  const requestBody = useCallback((): ChatRequestBody => {
    const s = settingsRef.current;
    return { model: s.model, effort: s.effort };
  }, []);

  return { settings, updateSettings, requestBody };
}
