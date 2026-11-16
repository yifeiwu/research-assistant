import { DEFAULT_EFFORT, isValidEffort, type EffortLevel } from "./effort";

/** Client-side settings (persisted in the browser). */
export type AppSettings = {
  effort: EffortLevel;
};

export const DEFAULT_SETTINGS: AppSettings = {
  effort: DEFAULT_EFFORT,
};

/** Whitelist-parse persisted settings, falling back to defaults for unknown values. */
export function sanitizeSettings(value: unknown): AppSettings {
  if (!value || typeof value !== "object") return { ...DEFAULT_SETTINGS };
  const v = value as Record<string, unknown>;
  return {
    effort: isValidEffort(v.effort) ? v.effort : DEFAULT_EFFORT,
  };
}
