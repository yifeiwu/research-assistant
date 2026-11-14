import { DEFAULT_GROQ_MODEL, GROQ_MODELS, isValidGroqModel } from "./models";
import { DEFAULT_EFFORT, type EffortLevel } from "./effort";

/** Client-side settings (persisted in the browser). Groq is the only provider. */
export type AppSettings = {
  model: string;
  effort: EffortLevel;
};

export const DEFAULT_SETTINGS: AppSettings = {
  model: DEFAULT_GROQ_MODEL,
  effort: DEFAULT_EFFORT,
};

function isEffort(value: unknown): value is EffortLevel {
  return value === "low" || value === "medium" || value === "high";
}

/**
 * Whitelist-parse persisted settings. Legacy payloads may contain custom
 * provider fields (including an API key); only the Groq model and effort are
 * retained so callers can rewrite the cleaned value back to storage.
 */
export function sanitizeSettings(value: unknown): AppSettings {
  if (!value || typeof value !== "object") return { ...DEFAULT_SETTINGS };
  const v = value as Record<string, unknown>;
  const legacyModel = typeof v.groqModel === "string" ? v.groqModel : undefined;
  const model = typeof v.model === "string" ? v.model : legacyModel;
  return {
    model: isValidGroqModel(model) ? model : DEFAULT_GROQ_MODEL,
    effort: isEffort(v.effort) ? v.effort : DEFAULT_EFFORT,
  };
}

/** Short label for the currently selected Groq model. */
export function currentModelLabel(settings: AppSettings): string {
  const found = GROQ_MODELS.find((m) => m.id === settings.model);
  return found?.label ?? settings.model;
}
