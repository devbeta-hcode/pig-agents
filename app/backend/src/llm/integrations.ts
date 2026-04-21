/**
 * Third-party LLM integrations — canonical OpenAI-compatible base URLs and helpers.
 * The HTTP client in `client.ts` still speaks one wire format; routing is by URL + model id.
 */

export type LlmProviderId = "chatgpt" | "gemini" | "openroute" | "claude" | "groq" | "ollama" | "local";

export type IntegrationKind = "managed_cloud" | "self_hosted";

export interface IntegrationDef {
  /** Public OpenAI-compatible API root (…/v1 or …/openai — see settings route for /models). */
  defaultBaseUrl: string;
  kind: IntegrationKind;
  /** Short note for logs / future UI. */
  description: string;
}

const CLOUD: IntegrationKind = "managed_cloud";
const SELF: IntegrationKind = "self_hosted";

/**
 * Built-in defaults — users do not need to paste these; empty profile baseUrl resolves here.
 * Claude: Anthropic documents OpenAI SDK–compatible calls at `https://api.anthropic.com/v1/`.
 */
export const LLM_INTEGRATIONS: Record<LlmProviderId, IntegrationDef> = {
  chatgpt: {
    defaultBaseUrl: "https://api.openai.com/v1",
    kind: CLOUD,
    description: "OpenAI official API",
  },
  gemini: {
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    kind: CLOUD,
    description: "Google AI Studio / Gemini OpenAI-compatible endpoint",
  },
  openroute: {
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    kind: CLOUD,
    description: "OpenRouter (many models, one OpenAI-compatible API)",
  },
  claude: {
    defaultBaseUrl: "https://api.anthropic.com/v1",
    kind: CLOUD,
    description: "Anthropic Claude API (OpenAI-compatible /v1 surface)",
  },
  groq: {
    defaultBaseUrl: "https://api.groq.com/openai/v1",
    kind: CLOUD,
    description: "Groq Cloud (fast inference)",
  },
  ollama: {
    defaultBaseUrl: "http://localhost:11434",
    kind: SELF,
    description: "Ollama native API",
  },
  local: {
    defaultBaseUrl: "http://localhost:11434/v1",
    kind: SELF,
    description: "Local OpenAI-compatible server (LM Studio, vLLM, …)",
  },
};

export function integrationFor(pid: LlmProviderId): IntegrationDef {
  return LLM_INTEGRATIONS[pid];
}

/** Effective base: non-empty stored value wins; otherwise integration default. */
export function resolveIntegrationBaseUrl(pid: LlmProviderId, storedBaseUrl: string | undefined): string {
  const t = (storedBaseUrl ?? "").trim();
  if (t) return t.replace(/\/$/, "");
  return LLM_INTEGRATIONS[pid].defaultBaseUrl.replace(/\/$/, "");
}

/** Cloud providers where the app ships a default endpoint (no user typing required). */
export function isManagedCloudProvider(pid: string): boolean {
  const p = pid as LlmProviderId;
  return p in LLM_INTEGRATIONS && LLM_INTEGRATIONS[p].kind === "managed_cloud";
}
