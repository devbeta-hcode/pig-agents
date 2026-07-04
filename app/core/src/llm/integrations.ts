/**
 * Third-party LLM integrations — canonical OpenAI-compatible base URLs and helpers.
 * The HTTP client in `client.ts` still speaks one wire format; routing is by URL + model id.
 */

export type LlmProviderId =
  | "chatgpt"
  | "gemini"
  | "openroute"
  | "claude"
  | "groq"
  | "deepseek"
  | "mistral"
  | "xai"
  | "moonshot"
  | "qwen"
  | "together"
  | "fireworks"
  | "cohere"
  | "perplexity"
  | "cursor"
  | "claude-cli"
  | "ollama"
  | "local";

/** Official cloud hosts that require a real API key (no placeholder Bearer). */
const STRICT_CLOUD_HOST =
  /openai\.com|googleapis\.com|openrouter\.ai|anthropic\.com|api\.groq\.com|api\.deepseek\.com|api\.mistral\.ai|api\.x\.ai|api\.together\.xyz|api\.fireworks\.ai|api\.moonshot\.ai|api\.cohere\.com|api\.perplexity\.ai|dashscope\.aliyuncs\.com/i;

export type IntegrationKind = "managed_cloud" | "self_hosted";

export interface IntegrationDef {
  /** Public OpenAI-compatible API root (…/v1 or …/openai — see settings route for /models). */
  defaultBaseUrl: string;
  kind: IntegrationKind;
  /** Settings dropdown label. */
  label: string;
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
    label: "ChatGPT (OpenAI)",
    description: "OpenAI official API",
  },
  gemini: {
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    kind: CLOUD,
    label: "Gemini (Google)",
    description: "Google AI Studio / Gemini OpenAI-compatible endpoint",
  },
  claude: {
    defaultBaseUrl: "https://api.anthropic.com/v1",
    kind: CLOUD,
    label: "Claude (Anthropic)",
    description: "Anthropic Claude API (OpenAI-compatible /v1 surface)",
  },
  deepseek: {
    defaultBaseUrl: "https://api.deepseek.com/v1",
    kind: CLOUD,
    label: "DeepSeek",
    description: "DeepSeek Chat / Reasoner (OpenAI-compatible)",
  },
  mistral: {
    defaultBaseUrl: "https://api.mistral.ai/v1",
    kind: CLOUD,
    label: "Mistral AI",
    description: "Mistral large / codestral models",
  },
  xai: {
    defaultBaseUrl: "https://api.x.ai/v1",
    kind: CLOUD,
    label: "xAI (Grok)",
    description: "xAI Grok models",
  },
  moonshot: {
    defaultBaseUrl: "https://api.moonshot.ai/v1",
    kind: CLOUD,
    label: "Moonshot (Kimi)",
    description: "Moonshot Kimi API (international endpoint)",
  },
  qwen: {
    defaultBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    kind: CLOUD,
    label: "Qwen (DashScope)",
    description: "Alibaba Cloud DashScope OpenAI-compatible mode",
  },
  groq: {
    defaultBaseUrl: "https://api.groq.com/openai/v1",
    kind: CLOUD,
    label: "Groq",
    description: "Groq Cloud (fast inference)",
  },
  together: {
    defaultBaseUrl: "https://api.together.xyz/v1",
    kind: CLOUD,
    label: "Together AI",
    description: "Together hosted open models",
  },
  fireworks: {
    defaultBaseUrl: "https://api.fireworks.ai/inference/v1",
    kind: CLOUD,
    label: "Fireworks AI",
    description: "Fireworks inference API",
  },
  cohere: {
    defaultBaseUrl: "https://api.cohere.com/compatibility/v1",
    kind: CLOUD,
    label: "Cohere",
    description: "Cohere Command models (OpenAI-compatible surface)",
  },
  perplexity: {
    defaultBaseUrl: "https://api.perplexity.ai",
    kind: CLOUD,
    label: "Perplexity",
    description: "Perplexity Sonar chat models",
  },
  openroute: {
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    kind: CLOUD,
    label: "OpenRouter",
    description: "OpenRouter (many models, one OpenAI-compatible API)",
  },
  cursor: {
    defaultBaseUrl: "https://api.cursor.com/v1",
    kind: CLOUD,
    label: "Cursor (Cloud Agents API)",
    description: "Cursor Cloud Agents API (not OpenAI chat/completions)",
  },
  "claude-cli": {
    defaultBaseUrl: "",
    kind: SELF,
    label: "Claude Code (SDK)",
    description: "Runs Claude Code headlessly via @anthropic-ai/claude-agent-sdk — uses an API key if set, else your local 'claude login' subscription. No base URL needed.",
  },
  ollama: {
    defaultBaseUrl: "http://localhost:11434",
    kind: SELF,
    label: "Ollama",
    description: "Ollama native API",
  },
  local: {
    defaultBaseUrl: "http://localhost:11434/v1",
    kind: SELF,
    label: "OpenAI-compatible (local)",
    description: "Local OpenAI-compatible server (LM Studio, vLLM, …)",
  },
};

export function integrationFor(pid: LlmProviderId): IntegrationDef {
  return LLM_INTEGRATIONS[pid];
}

/** Effective base: non-empty stored value wins; otherwise integration default. */
export function resolveIntegrationBaseUrl(pid: LlmProviderId, storedBaseUrl: string | undefined): string {
  const t = (storedBaseUrl ?? "").trim();
  if (t) {
    const cleaned = t.replace(/\/$/, "");
    if (pid === "cursor") {
      return cleaned.replace(/\/agents$/i, "").replace(/\/$/, "") || LLM_INTEGRATIONS.cursor.defaultBaseUrl;
    }
    return cleaned;
  }
  return LLM_INTEGRATIONS[pid].defaultBaseUrl.replace(/\/$/, "");
}

/** Cloud providers where the app ships a default endpoint (no user typing required). */
export function isManagedCloudProvider(pid: string): boolean {
  const p = pid as LlmProviderId;
  return p in LLM_INTEGRATIONS && LLM_INTEGRATIONS[p].kind === "managed_cloud";
}

/** True when the endpoint is a hosted API that rejects placeholder Bearer tokens. */
export function isStrictCloudHost(url: string): boolean {
  return STRICT_CLOUD_HOST.test(url);
}

/** Providers that probe models via OpenAI-shaped `/v1/models` (everything except Ollama native). */
export function isOpenAiShapedProvider(pid: string): boolean {
  return pid !== "ollama";
}
