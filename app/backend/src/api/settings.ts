import { Router } from "express";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import url from "node:url";
import { LLM_INTEGRATIONS, resolveIntegrationBaseUrl } from "../llm/integrations.js";
import { normalizePromptMode } from "../llm/prompt-mode.js";
import {
  buildMergedProfiles,
  DEFAULT_PROFILES,
  ensureProfilesSeededFromEnv,
  mergeProfile,
  migrateLegacyEnvApiKeyIntoProfiles,
  normalizeLlmProviderId,
  profileApiKeySet,
  profilesFilePath,
  readProfilesFile,
  type ProfileSlot,
  writeProfilesFile,
} from "../llm/profiles.js";

export const settingsRouter = Router();

const SAFE_KEYS = [
  "LLM_PROVIDER",
  "BASE_URL",
  "MODEL",
  "MAX_CONTEXT_FILES",
  "MAX_ITERATIONS",
  "PROMPT_MODE",
  "LLM_MAX_TOKENS",
];
const ALL_KEYS = [...SAFE_KEYS, "OPENAI_API_KEY", "PORT", "WORKSPACE_ROOT", "ALLOWED_WORKSPACE_ROOT"];

function envFilePath(): string {
  // src is at app/backend/src/api/settings.ts → resolve app/.env
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  return path.resolve(here, "../../../.env");
}

async function readEnvFile(): Promise<Record<string, string>> {
  const p = envFilePath();
  const out: Record<string, string> = {};
  try {
    const txt = await fsp.readFile(p, "utf8");
    for (const line of txt.split(/\r?\n/)) {
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq < 0) continue;
      const k = line.slice(0, eq).trim();
      const v = line.slice(eq + 1);
      out[k] = v;
    }
  } catch { /* file may not exist */ }
  return out;
}

async function writeEnvFile(updates: Record<string, string | undefined>) {
  const p = envFilePath();
  const cur = await readEnvFile();
  for (const [k, v] of Object.entries(updates)) {
    if (v === undefined) delete cur[k];
    else cur[k] = v;
  }
  // preserve a stable, readable order
  const order = ["LLM_PROVIDER", "OPENAI_API_KEY", "BASE_URL", "MODEL",
    "MAX_CONTEXT_FILES", "MAX_ITERATIONS", "PROMPT_MODE", "LLM_MAX_TOKENS", "PORT", "WORKSPACE_ROOT", "ALLOWED_WORKSPACE_ROOT"];
  const lines: string[] = [];
  for (const k of order) if (k in cur) lines.push(`${k}=${cur[k]}`);
  for (const k of Object.keys(cur)) if (!order.includes(k)) lines.push(`${k}=${cur[k]}`);
  await fsp.writeFile(p, lines.join("\n") + "\n", "utf8");
}

settingsRouter.get("/settings", (_req, res) => {
  let data = readProfilesFile();
  data = ensureProfilesSeededFromEnv(data);
  data = migrateLegacyEnvApiKeyIntoProfiles(data);
  const pid = normalizeLlmProviderId(process.env.LLM_PROVIDER);
  const slot = mergeProfile(pid, data);
  const merged = buildMergedProfiles(data);
  res.json({
    LLM_PROVIDER: pid,
    BASE_URL: slot.baseUrl,
    MODEL: slot.model,
    PROFILES: merged,
    MAX_CONTEXT_FILES: Number(process.env.MAX_CONTEXT_FILES || 5),
    MAX_ITERATIONS: Number(process.env.MAX_ITERATIONS || 20),
    PROMPT_MODE: normalizePromptMode(process.env.PROMPT_MODE || "balanced"),
    LLM_MAX_TOKENS: (() => {
      const raw = process.env.LLM_MAX_TOKENS;
      if (raw === undefined || raw === "") return 0;
      const n = Number(raw);
      return Number.isFinite(n) && n >= 64 ? Math.min(8192, Math.floor(n)) : 0;
    })(),
    OPENAI_API_KEY_SET: profileApiKeySet(pid, data),
    ENV_FILE: envFilePath(),
    PROFILES_FILE: profilesFilePath(),
    INTEGRATIONS: LLM_INTEGRATIONS,
  });
});

settingsRouter.post("/settings", async (req, res) => {
  const body = req.body || {};
  let data = readProfilesFile();
  data = ensureProfilesSeededFromEnv(data);
  data = migrateLegacyEnvApiKeyIntoProfiles(data);

  const prevPid = normalizeLlmProviderId(process.env.LLM_PROVIDER);
  const pid =
    body.LLM_PROVIDER !== undefined && body.LLM_PROVIDER !== null
      ? normalizeLlmProviderId(String(body.LLM_PROVIDER))
      : prevPid;

  const onlyProviderSwitch =
    body.LLM_PROVIDER !== undefined &&
    body.BASE_URL === undefined &&
    body.MODEL === undefined &&
    body.OPENAI_API_KEY === undefined;

  const def = DEFAULT_PROFILES[pid];
  const prev: Partial<ProfileSlot> = data.profiles[pid] ?? {};

  let nextBase = prev.baseUrl ?? def.baseUrl;
  let nextModel = prev.model ?? def.model;
  let nextApiKey = prev.apiKey;

  if (!onlyProviderSwitch) {
    if (body.BASE_URL !== undefined) nextBase = String(body.BASE_URL);
    if (body.MODEL !== undefined) nextModel = String(body.MODEL);
  }
  if (body.OPENAI_API_KEY !== undefined) {
    const v = String(body.OPENAI_API_KEY);
    nextApiKey = v.length > 0 ? v : undefined;
  }

  const slot: ProfileSlot = { baseUrl: nextBase, model: nextModel };
  if (nextApiKey && nextApiKey.length > 0) slot.apiKey = nextApiKey;
  data.profiles[pid] = slot;

  try {
    writeProfilesFile(data);
  } catch (err) {
    return res.status(500).json({ ok: false, error: `failed to persist profiles: ${(err as Error).message}` });
  }

  const merged = mergeProfile(pid, data);
  process.env.LLM_PROVIDER = pid;
  process.env.BASE_URL = merged.baseUrl;
  process.env.MODEL = merged.model;
  if (slot.apiKey && slot.apiKey.length > 0) process.env.OPENAI_API_KEY = slot.apiKey;
  else delete process.env.OPENAI_API_KEY;

  const persisted: Record<string, string | undefined> = {};
  persisted.LLM_PROVIDER = pid;
  persisted.BASE_URL = merged.baseUrl;
  persisted.MODEL = merged.model;
  persisted.OPENAI_API_KEY = undefined;

  for (const key of SAFE_KEYS) {
    if (key === "LLM_PROVIDER" || key === "BASE_URL" || key === "MODEL") continue;
    if (key in body && body[key] !== undefined && body[key] !== null) {
      if (key === "LLM_MAX_TOKENS") {
        const n = Number(body[key]);
        if (!Number.isFinite(n) || n <= 0) {
          delete process.env.LLM_MAX_TOKENS;
          persisted.LLM_MAX_TOKENS = undefined;
        } else {
          const capped = Math.min(8192, Math.max(64, Math.floor(n)));
          const str = String(capped);
          process.env.LLM_MAX_TOKENS = str;
          persisted.LLM_MAX_TOKENS = str;
        }
        continue;
      }
      let value = String(body[key]);
      if (key === "PROMPT_MODE") value = normalizePromptMode(value);
      process.env[key] = value;
      persisted[key] = value;
    }
  }
  let saved = false;
  try {
    await writeEnvFile(persisted);
    saved = true;
  } catch (err) {
    return res.status(500).json({ ok: false, error: `failed to persist .env: ${(err as Error).message}` });
  }
  res.json({ ok: true, saved, envFile: envFilePath(), profilesFile: profilesFilePath() });
});

/**
 * GET /ollama/models — proxy `GET <base>/api/tags` so the UI can populate a
 * model dropdown with whatever the user actually has pulled. The query
 * param `?base=` overrides the saved BASE_URL (used by Settings before save).
 *
 * Errors are reported as `{ ok: false, error }` with HTTP 200 because the
 * UI treats it as "no models discovered" instead of a hard failure — Ollama
 * may simply not be installed or running on this machine.
 */
settingsRouter.get("/ollama/models", async (req, res) => {
  // Pick a base: explicit query → BASE_URL → default. Strip trailing /v1
  // since the native API lives directly at /api/tags.
  let base = String(req.query.base || process.env.BASE_URL || "http://localhost:11434").trim();
  base = base.replace(/\/$/, "").replace(/\/v1$/, "");
  const url = base + "/api/tags";
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 2500);
    const r = await fetch(url, { signal: ctl.signal });
    clearTimeout(t);
    if (!r.ok) return res.json({ ok: false, error: `Ollama responded ${r.status}` });
    const data = (await r.json()) as { models?: { name: string; size?: number; modified_at?: string }[] };
    const models = (data.models || []).map((m) => m.name).filter(Boolean);
    return res.json({ ok: true, base, models });
  } catch (err) {
    return res.json({ ok: false, error: (err as Error).message, base });
  }
});

/**
 * Resolve `GET …/models` for OpenAI-compatible servers.
 * Google Gemini uses `…/openai` without a trailing `/v1` segment.
 */
function openAiCompatibleModelsListUrl(rawBase: string): string {
  let b = rawBase.trim().replace(/\/$/, "");
  if (!b) b = "http://localhost:11434/v1";
  else if (/\/openai$/i.test(b)) return `${b}/models`;
  else if (!/\/v1$/i.test(b)) b = `${b}/v1`;
  return `${b}/models`;
}

function authHeadersForModelsList(listUrl: string): Record<string, string> {
  const key = process.env.OPENAI_API_KEY;
  // Anthropic REST uses x-api-key + anthropic-version — NOT Bearer (→ HTTP 401 on GET /v1/models).
  if (/anthropic\.com/i.test(listUrl)) {
    if (!key) return {};
    return {
      "x-api-key": key,
      "anthropic-version": process.env.ANTHROPIC_API_VERSION?.trim() || "2023-06-01",
    };
  }
  const strictCloud = /openai\.com|googleapis\.com|openrouter\.ai|api\.groq\.com/i.test(listUrl);
  if (strictCloud) {
    if (!key) return {};
    return { Authorization: `Bearer ${key}` };
  }
  return { Authorization: `Bearer ${key || "local"}` };
}

/**
 * GET /openai-compatible/models — proxy `GET <base>/v1/models` so the Settings
 * UI can populate a dropdown (LM Studio, Ollama /v1, vLLM, cloud OpenAI, …).
 * Query `?base=` overrides BASE_URL (same idea as /ollama/models).
 */
settingsRouter.get("/openai-compatible/models", async (req, res) => {
  let raw = String(req.query.base ?? process.env.BASE_URL ?? "").trim();
  if (!raw) {
    const prov = normalizeLlmProviderId(process.env.LLM_PROVIDER);
    raw = resolveIntegrationBaseUrl(prov, "");
  }
  const listUrl = openAiCompatibleModelsListUrl(raw);
  const headers = authHeadersForModelsList(listUrl);
  const needsCloudKey =
    /openai\.com|googleapis\.com|openrouter\.ai|anthropic\.com|api\.groq\.com/i.test(listUrl);
  if (needsCloudKey && Object.keys(headers).length === 0) {
    return res.json({ ok: false, error: "OPENAI_API_KEY not set", base: listUrl });
  }
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 8000);
    const r = await fetch(listUrl, { signal: ctl.signal, headers });
    clearTimeout(t);
    if (!r.ok) {
      return res.json({ ok: false, error: `HTTP ${r.status}`, base: listUrl });
    }
    const data = (await r.json()) as { data?: { id?: string }[] };
    const models = (data.data || []).map((m) => m.id).filter(Boolean) as string[];
    models.sort((a, b) => a.localeCompare(b));
    return res.json({ ok: true, base: listUrl.replace(/\/models$/, ""), models });
  } catch (err) {
    return res.json({ ok: false, error: (err as Error).message, base: listUrl });
  }
});

// Mark unused-imports as used for tooling
void ALL_KEYS;
