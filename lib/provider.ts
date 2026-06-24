import { DEFAULT_GROQ_MODEL } from "./models";

export type ProviderType = "groq" | "custom";

/** Client-side settings (persisted in the browser). */
export type ProviderSettings = {
  provider: ProviderType;
  groqModel: string;
  customBaseURL: string;
  customApiKey: string;
  customModel: string;
};

export const DEFAULT_PROVIDER_SETTINGS: ProviderSettings = {
  provider: "groq",
  groqModel: DEFAULT_GROQ_MODEL,
  customBaseURL: "",
  customApiKey: "",
  customModel: "",
};

/**
 * Payload describing a custom OpenAI-compatible endpoint, sent in the request
 * body when the user opts to use their own provider.
 */
export type CustomProviderPayload = {
  type: "custom";
  baseURL: string;
  apiKey: string;
  model: string;
};

export function isCustomProviderPayload(
  value: unknown,
): value is CustomProviderPayload {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    v.type === "custom" &&
    typeof v.baseURL === "string" &&
    v.baseURL.trim().length > 0 &&
    typeof v.apiKey === "string" &&
    v.apiKey.trim().length > 0 &&
    typeof v.model === "string" &&
    v.model.trim().length > 0
  );
}
