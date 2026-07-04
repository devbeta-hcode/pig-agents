import {
  type LlmProviderId,
  resolveIntegrationBaseUrl,
} from "./integrations.js";
import { getProfileStorage } from "./profileStorage.js";

export type { LlmProviderId } from "./integrations.js";

export const LLM_PROVIDER_IDS: LlmProviderId[] = [
  "chatgpt",
  "gemini",
  "claude",
  "deepseek",
  "mistral",
  "xai",
  "moonshot",
  "qwen",
  "groq",
  "together",
  "fireworks",
  "cohere",
  "perplexity",
  "openroute",
  "cursor",
  "claude-cli",
  "ollama",
  "local",
];

/** One provider row in electron-store (`llm-profiles`) — API key is per provider, not global `.env`. */
export interface ProfileSlot {
  baseUrl: string;
  model: string;
  /** Optional; when set, used as Bearer for this provider. */
  apiKey?: string;
}

/** Empty `baseUrl` means “use built-in integration default” (see `integrations.ts`). */
export const DEFAULT_PROFILES: Record<LlmProviderId, { baseUrl: string; model: string }> = {
  chatgpt: { baseUrl: "", model: "" },
  gemini: { baseUrl: "", model: "" },
  claude: { baseUrl: "", model: "" },
  deepseek: { baseUrl: "", model: "deepseek-chat" },
  mistral: { baseUrl: "", model: "mistral-large-latest" },
  xai: { baseUrl: "", model: "grok-3-mini" },
  moonshot: { baseUrl: "", model: "moonshot-v1-8k" },
  qwen: { baseUrl: "", model: "qwen-plus" },
  groq: { baseUrl: "", model: "llama-3.3-70b-versatile" },
  together: { baseUrl: "", model: "" },
  fireworks: { baseUrl: "", model: "" },
  cohere: { baseUrl: "", model: "command-r-plus-08-2024" },
  perplexity: { baseUrl: "", model: "sonar" },
  openroute: { baseUrl: "", model: "" },
  cursor: { baseUrl: "", model: "composer-2" },
  "claude-cli": { baseUrl: "", model: "" },
  ollama: { baseUrl: "", model: "llama3.2" },
  local: { baseUrl: "", model: "" },
};

export interface LlmProfilesFile {
  version: 1;
  profiles: Partial<Record<LlmProviderId, ProfileSlot>>;
}

/** @deprecated Prefer `profilesStorageLocation()`. */
export function profilesFilePath(): string {
  return profilesStorageLocation();
}

export function profilesStorageLocation(): string {
  return getProfileStorage().location();
}

export function readProfilesFile(): LlmProfilesFile {
  return getProfileStorage().read();
}

export function writeProfilesFile(data: LlmProfilesFile): void {
  getProfileStorage().write(data);
}

export function normalizeLlmProviderId(raw: string | undefined): LlmProviderId {
  const p = (raw || "chatgpt").toLowerCase();
  if (p === "openai") return "chatgpt";
  if (p === "grok") return "xai";
  if (p === "kimi") return "moonshot";
  if (p === "dashscope" || p === "alibaba") return "qwen";
  if ((LLM_PROVIDER_IDS as string[]).includes(p)) return p as LlmProviderId;
  return "chatgpt";
}

export function mergeProfile(
  pid: LlmProviderId,
  data: LlmProfilesFile,
): { baseUrl: string; model: string } {
  const def = DEFAULT_PROFILES[pid];
  const cur = data.profiles[pid];
  const rawBase = cur?.baseUrl ?? def.baseUrl;
  return {
    baseUrl: resolveIntegrationBaseUrl(pid, rawBase),
    model: cur?.model ?? def.model,
  };
}

/** Whether this provider has a stored API key (for Settings UI). */
export function profileApiKeySet(pid: LlmProviderId, data: LlmProfilesFile): boolean {
  return Boolean(data.profiles[pid]?.apiKey && data.profiles[pid]!.apiKey!.length > 0);
}

export interface MergedProfileRow {
  baseUrl: string;
  model: string;
  apiKeySet: boolean;
}

export function buildMergedProfiles(data: LlmProfilesFile): Record<LlmProviderId, MergedProfileRow> {
  const out = {} as Record<LlmProviderId, MergedProfileRow>;
  for (const id of LLM_PROVIDER_IDS) {
    const m = mergeProfile(id, data);
    out[id] = {
      baseUrl: m.baseUrl,
      model: m.model,
      apiKeySet: profileApiKeySet(id, data),
    };
  }
  return out;
}

/**
 * Overlay `process.env` for the active provider from electron-store profiles.
 */
export function hydrateEnvFromProfiles(): void {
  let data: LlmProfilesFile;
  try {
    data = readProfilesFile();
    if (data.version !== 1 || !data.profiles) return;
  } catch {
    return;
  }
  data = migrateLegacyEnvApiKeyIntoProfiles(data);
  const pid = normalizeLlmProviderId(process.env.LLM_PROVIDER);
  const slot = mergeProfile(pid, data);
  process.env.LLM_PROVIDER = pid;
  process.env.BASE_URL = slot.baseUrl;
  process.env.MODEL = slot.model;
  const k = data.profiles[pid]?.apiKey;
  if (k && k.length > 0) process.env.OPENAI_API_KEY = k;
}

/**
 * First-time: copy current `.env` LLM_* into the matching profile slot and persist.
 */
export function ensureProfilesSeededFromEnv(data: LlmProfilesFile): LlmProfilesFile {
  if (Object.keys(data.profiles).length > 0) return data;
  const pid = normalizeLlmProviderId(process.env.LLM_PROVIDER);
  const seed: ProfileSlot = {
    baseUrl: process.env.BASE_URL ?? DEFAULT_PROFILES[pid].baseUrl,
    model: process.env.MODEL ?? DEFAULT_PROFILES[pid].model,
  };
  if (process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.length > 0) {
    seed.apiKey = process.env.OPENAI_API_KEY;
  }
  data.profiles[pid] = seed;
  try {
    writeProfilesFile(data);
  } catch {
    /* noop */
  }
  return data;
}

/**
 * Move legacy `OPENAI_API_KEY` from `.env` into the active profile once no profile has a key yet.
 */
export function migrateLegacyEnvApiKeyIntoProfiles(data: LlmProfilesFile): LlmProfilesFile {
  const anyKey = LLM_PROVIDER_IDS.some((id) => data.profiles[id]?.apiKey?.length);
  if (anyKey) return data;
  const envKey = process.env.OPENAI_API_KEY?.trim();
  if (!envKey) return data;
  const pid = normalizeLlmProviderId(process.env.LLM_PROVIDER);
  const prev = data.profiles[pid] || {
    baseUrl: DEFAULT_PROFILES[pid].baseUrl,
    model: DEFAULT_PROFILES[pid].model,
  };
  data.profiles[pid] = { ...prev, apiKey: envKey };
  try {
    writeProfilesFile(data);
  } catch {
    /* noop */
  }
  return data;
}
