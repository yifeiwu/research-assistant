import { DEFAULT_GROQ_MODEL, groqModelLabel, isValidGroqModel } from "./models";
import { DEFAULT_EFFORT, isValidEffort, type EffortLevel } from "./effort";

/** Client-side settings (persisted in the browser). Groq is the only provider. */
export type AppSettings = {
  model: string;
  effort: EffortLevel;
};

export const DEFAULT_SETTINGS: AppSettings = {
  model: DEFAULT_GROQ_MODEL,
  effort: DEFAULT_EFFORT,
};

/** Whitelist-parse persisted settings, falling back to defaults for unknown values. */
export function sanitizeSettings(value: unknown): AppSettings {
  if (!value || typeof value !== "object") return { ...DEFAULT_SETTINGS };
  const v = value as Record<string, unknown>;
  return {
    model: isValidGroqModel(v.model) ? v.model : DEFAULT_GROQ_MODEL,
    effort: isValidEffort(v.effort) ? v.effort : DEFAULT_EFFORT,
  };
}

/** Short label for the currently selected Groq model. */
export function currentModelLabel(settings: AppSettings): string {
  return groqModelLabel(settings.model);
}
