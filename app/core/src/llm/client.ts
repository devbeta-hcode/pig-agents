import { logger } from "../utils/logger.js";
import { resolveIntegrationBaseUrl, isStrictCloudHost } from "./integrations.js";
import { normalizeLlmProviderId } from "./profiles.js";
import { cursorChat, cursorChatStream } from "./cursorClient.js";

/** A simple text content part. */
export interface TextContentPart {
  type: "text";
  text: string;
}

/** An image content part (base64 data URL). */
export interface ImageContentPart {
  type: "image_url";
  image_url: { url: string };
}

export type ContentPart = TextContentPart | ImageContentPart;

export type ChatMessage =
  | { role: "system" | "user" | "assistant"; content: string | ContentPart[] };

export interface LLMUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface LLMOptions {
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  onToken?: (delta: string) => void;
  /** Fired when the provider reports token usage (non-stream JSON or final stream chunk). */
  onUsage?: (usage: LLMUsage) => void;
}

type Provider = "openai" | "local" | "ollama" | "cursor";

/** Wire protocol: chatgpt / gemini / openroute / claude → OpenAI-compatible HTTP. */
function provider(): Provider {
  const p = normalizeLlmProviderId(process.env.LLM_PROVIDER);
  if (p === "cursor") return "cursor";
  if (p === "ollama") return "ollama";
  if (p === "local") return "local";
  return "openai";
}

function isCursorProvider(): boolean {
  return provider() === "cursor";
}

/**
 * Returns the base URL **without** any path suffix — callers append their
 * own (`/chat/completions` for OpenAI-compatible, `/api/chat` for Ollama
 * native). Trailing slashes are stripped.
 */
function baseUrl(): string {
  const pid = normalizeLlmProviderId(process.env.LLM_PROVIDER);
  return resolveIntegrationBaseUrl(pid, process.env.BASE_URL);
}

/**
 * Full chat endpoint. For Ollama we hit the **native** `/api/chat` (NDJSON
 * stream, no Bearer). For everything else we go through the OpenAI-shaped
 * `/chat/completions`. If the user pasted a `BASE_URL` that already ends
 * in `/v1` we treat it as OpenAI-compatible regardless of the provider
 * field (ergonomic escape hatch).
 */
function endpoint(): string {
  const b = baseUrl();
  if (provider() === "ollama" && !/\/v1$/.test(b)) {
    return b + "/api/chat";
  }
  return b + "/chat/completions";
}

function isOllamaNative(): boolean {
  return /\/api\/chat$/.test(endpoint());
}

/** Anthropic `…/v1/chat/completions` rejects `temperature` on several newer models (400 deprecated). */
function anthropicOpenAiOmitsTemperature(): boolean {
  return /anthropic\.com/i.test(endpoint());
}

/** Official clouds that reject placeholder Bearer tokens. */
function isStrictCloudEndpoint(): boolean {
  return isStrictCloudHost(endpoint());
}

function model(): string {
  if (process.env.MODEL) return process.env.MODEL;
  if (/openai\.com/i.test(endpoint())) return "gpt-4o-mini";
  if (provider() === "ollama") return "llama3.2";
  return "qwen2.5-coder";
}

function authHeader(): Record<string, string> {
  // Ollama's native API doesn't speak Bearer auth — sending one is harmless
  // but pointless, so we just omit it for cleanliness.
  if (isOllamaNative()) return {};
  // Only the real OpenAI endpoint requires a real key; everything else is
  // assumed to be an OpenAI-compatible local server that accepts any token.
  if (isStrictCloudEndpoint()) {
    const key = process.env.OPENAI_API_KEY;
    if (!key || key === "xxxx" || key === "your-api-key-here") {
      throw new Error(
        "OPENAI_API_KEY is not set. Open ⚙ Settings and paste a real key for this provider, " +
          "or use Ollama / local OpenAI-compatible with a dev server.",
      );
    }
    return { Authorization: `Bearer ${key}` };
  }
  const key = process.env.OPENAI_API_KEY || "local";
  return { Authorization: `Bearer ${key}` };
}

let lastLoggedConfig = "";
function logConfigOnce(url: string, modelName: string) {
  const sig = `${url}|${modelName}`;
  if (sig === lastLoggedConfig) return;
  lastLoggedConfig = sig;
  logger.info(`LLM → ${modelName} @ ${url}`);
}

/** Whether the current endpoint + model accept OpenAI-style `image_url` content parts. */
export function llmSupportsVision(): boolean {
  const url = endpoint();
  const m = model().toLowerCase();

  if (/api\.deepseek\.com/i.test(url)) return false;

  if (/openai\.com/i.test(url)) {
    return /gpt-4o|gpt-4-turbo|gpt-4-vision|gpt-4\.1|o1|o3|chatgpt-4o/i.test(m);
  }
  if (/generativelanguage\.googleapis|gemini/i.test(url)) return true;
  if (/anthropic\.com/i.test(url)) {
    return /claude-3|claude-sonnet-4|claude-opus-4|claude-haiku-4/i.test(m);
  }
  if (/openrouter\.ai/i.test(url)) {
    return /vision|gpt-4o|claude-3|gemini|llava|qwen.*vl|glm-4v/i.test(m);
  }
  if (/api\.groq\.com/i.test(url)) {
    return /vision|llava|gemma.*vision|llama-3\.2-vision/i.test(m);
  }
  if (isOllamaNative()) {
    return /llava|vision|bakllava|moondream|llama.*vision|gemma.*vision|qwen.*vl|glm-4v/i.test(m);
  }
  return /gpt-4o|vision|llava|multimodal|qwen.*vl|glm-4v|gemini/i.test(m);
}

function messageHasImages(content: string | ContentPart[]): boolean {
  return Array.isArray(content) && content.some((p) => p.type === "image_url");
}

function stripImagesFromMessages(messages: ChatMessage[]): ChatMessage[] {
  const note =
    "[Attached image(s) were not sent: this LLM endpoint only accepts text. " +
    "Use a vision-capable model (e.g. GPT-4o, Gemini, Claude 3+) or describe the image in your message.]";
  return messages.map((msg) => {
    if (!messageHasImages(msg.content)) return msg;
    const parts = msg.content as ContentPart[];
    const text = parts
      .filter((p): p is TextContentPart => p.type === "text")
      .map((p) => p.text)
      .join("\n\n")
      .trim();
    const imageCount = parts.filter((p) => p.type === "image_url").length;
    const suffix = imageCount > 0 ? `\n\n${note}` : "";
    return { ...msg, content: (text + suffix).trim() || note };
  });
}

let lastVisionStripSig = "";
function prepareWireMessages(messages: ChatMessage[]): ChatMessage[] {
  if (llmSupportsVision()) return messages;
  const hasImages = messages.some((m) => messageHasImages(m.content));
  if (!hasImages) return messages;
  const sig = `${endpoint()}|${model()}`;
  if (lastVisionStripSig !== sig) {
    lastVisionStripSig = sig;
    logger.warn(
      `LLM ${model()} @ ${endpoint()} does not support image_url — attached images omitted (text-only request).`,
    );
  }
  return stripImagesFromMessages(messages);
}

const MAX_429_ATTEMPTS = 8;

function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
      return;
    }
    const t = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function is429ChatError(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err);
  return /\b429\b/.test(m) || /rate_limit/i.test(m);
}

const BACKOFF_CAP_MS = 120_000;
const BACKOFF_JITTER_MS = 400;

/** Derive wait time from 429 response (headers embedded by executeChat + common JSON bodies). */
function backoffMsFrom429Error(err: unknown): number {
  const m = err instanceof Error ? err.message : String(err);

  const parsedHeader = m.match(/\[Retry-After:\s*(\d+)\]/);
  if (parsedHeader) {
    const sec = parseInt(parsedHeader[1], 10);
    if (Number.isFinite(sec) && sec > 0) {
      return Math.min(BACKOFF_CAP_MS, sec * 1000 + BACKOFF_JITTER_MS);
    }
  }

  const tryAgain = m.match(/(?:please\s+)?try again in ([\d.]+)\s*s/i);
  if (tryAgain) {
    return Math.min(BACKOFF_CAP_MS, Math.ceil(parseFloat(tryAgain[1]) * 1000) + BACKOFF_JITTER_MS);
  }

  const afterSeconds = m.match(/try again after (\d+)\s*(?:s(?:ec(?:onds?)?)?)?\b/i);
  if (afterSeconds) {
    const sec = parseInt(afterSeconds[1], 10);
    if (Number.isFinite(sec) && sec > 0) {
      return Math.min(BACKOFF_CAP_MS, sec * 1000 + BACKOFF_JITTER_MS);
    }
  }

  const retryAfterMs = m.match(/"retry_after_ms"\s*:\s*(\d+)/i);
  if (retryAfterMs) {
    const ms = parseInt(retryAfterMs[1], 10);
    if (Number.isFinite(ms) && ms > 0) return Math.min(BACKOFF_CAP_MS, ms + BACKOFF_JITTER_MS);
  }

  const retryAfterSec = m.match(/"retry_after"\s*:\s*([\d.]+)/i);
  if (retryAfterSec) {
    const sec = parseFloat(retryAfterSec[1]);
    if (Number.isFinite(sec) && sec > 0) {
      return Math.min(BACKOFF_CAP_MS, Math.ceil(sec * 1000) + BACKOFF_JITTER_MS);
    }
  }

  return 10_000;
}

export async function chat(messages: ChatMessage[], opts: LLMOptions = {}): Promise<string> {
  if (isCursorProvider()) return cursorChat(messages, opts);
  let lastErr: Error | undefined;
  for (let attempt = 0; attempt < MAX_429_ATTEMPTS; attempt++) {
    try {
      return await executeChat(messages, opts);
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      if (!is429ChatError(lastErr) || attempt >= MAX_429_ATTEMPTS - 1) throw lastErr;
      const waitMs = backoffMsFrom429Error(lastErr);
      logger.warn(
        `LLM rate limited (429); waiting ~${Math.ceil(waitMs / 1000)}s before retry (${attempt + 2}/${MAX_429_ATTEMPTS})`,
      );
      await sleepWithSignal(waitMs, opts.signal);
    }
  }
  throw lastErr ?? new Error("LLM chat failed");
}

async function executeChat(messages: ChatMessage[], opts: LLMOptions): Promise<string> {
  const stream = !!opts.onToken;
  const url = endpoint();
  const modelName = model();
  const ollama = isOllamaNative();
  const wireMessages = prepareWireMessages(messages);
  logConfigOnce(url, modelName);
  // Two distinct request shapes:
  //   - OpenAI-compatible: { model, messages, temperature, max_tokens, stream }
  //   - Ollama native:     { model, messages, stream, options: { temperature, num_predict } }
  // Ollama returns 400 if it sees `max_tokens` or top-level `temperature`.
  const skipTemp = !ollama && anthropicOpenAiOmitsTemperature();
  const body = ollama
    ? {
        model: modelName,
        messages: wireMessages,
        stream,
        options: {
          temperature: opts.temperature ?? 0.2,
          num_predict: opts.maxTokens ?? 1500,
        },
      }
    : skipTemp
      ? {
          model: modelName,
          messages: wireMessages,
          max_tokens: opts.maxTokens ?? 1500,
          stream,
          ...(stream ? { stream_options: { include_usage: true } } : {}),
        }
      : {
          model: modelName,
          messages: wireMessages,
          temperature: opts.temperature ?? 0.2,
          max_tokens: opts.maxTokens ?? 1500,
          stream,
          ...(stream ? { stream_options: { include_usage: true } } : {}),
        };

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: stream ? "text/event-stream" : "application/json",
        ...authHeader(),
      },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    // Walk the cause chain to find an underlying syscall error code (ECONNREFUSED, ENOTFOUND, …).
    let code = "";
    let detail = "";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let cur: any = err;
    for (let i = 0; cur && i < 5; i++) {
      if (typeof cur.code === "string" && /^E[A-Z]+$/.test(cur.code)) { code = cur.code; break; }
      if (typeof cur.errno === "number" && cur.syscall) { code = String(cur.syscall).toUpperCase(); break; }
      if (!detail && typeof cur.message === "string") detail = cur.message;
      cur = cur.cause;
    }
    const hint =
      code === "ECONNREFUSED"
        ? `Cannot connect to LLM at ${url}. Is your local model server running? Open ⚙ Settings → Base URL.`
        : code === "ENOTFOUND" || code === "EAI_AGAIN"
        ? `Cannot resolve LLM host for ${url}. Check Settings → Base URL.`
        : code === "ETIMEDOUT" || code === "ECONNRESET"
        ? `Network error talking to LLM at ${url} (${code}). Server may be down.`
        : `Network error talking to LLM at ${url}: ${detail || (err as Error).message}`;
    throw new Error(hint);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let suffix = "";
    if (res.status === 429) {
      const ra = res.headers.get("retry-after")?.trim();
      if (ra && /^\d+$/.test(ra)) suffix += ` [Retry-After: ${ra}]`;
    }
    throw new Error(`LLM ${url} returned ${res.status}: ${text.slice(0, 1200)}${suffix}`);
  }

  if (!stream) {
    const data = (await res.json()) as {
      // OpenAI-compatible
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      // Ollama native
      message?: { content?: string };
      prompt_eval_count?: number;
      eval_count?: number;
    };
    const content =
      (ollama
        ? data.message?.content
        : data.choices?.[0]?.message?.content
      )?.trim();
    if (!content) {
      logger.warn("LLM returned empty content", JSON.stringify(data).slice(0, 300));
      throw new Error("LLM returned empty content");
    }
    const usage = parseLlmUsage(data, ollama);
    if (usage) {
      try { opts.onUsage?.(usage); } catch { /* noop */ }
    }
    return content;
  }

  // Streaming path — delegate to shared SSE/NDJSON decoder.
  let full = "";
  const usageRef: { value?: LLMUsage } = {};
  for await (const delta of _sseStream(res, ollama, usageRef)) {
    full += delta;
    try { opts.onToken?.(delta); } catch { /* noop */ }
  }
  if (usageRef.value) {
    try { opts.onUsage?.(usageRef.value); } catch { /* noop */ }
  }
  const content = full.trim();
  if (!content) throw new Error("LLM returned empty content");
  return content;
}

/**
 * Decodes an HTTP streaming response (OpenAI SSE or Ollama NDJSON) into
 * individual token-delta strings. Shared by `executeChat` and `chatStream`.
 */
function parseLlmUsage(
  data: {
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    prompt_eval_count?: number;
    eval_count?: number;
  },
  ollama: boolean,
): LLMUsage | undefined {
  if (ollama) {
    const prompt = data.prompt_eval_count;
    const completion = data.eval_count;
    if (prompt == null && completion == null) return undefined;
    return {
      promptTokens: prompt,
      completionTokens: completion,
      totalTokens: (prompt ?? 0) + (completion ?? 0),
    };
  }
  const u = data.usage;
  if (!u) return undefined;
  return {
    promptTokens: u.prompt_tokens,
    completionTokens: u.completion_tokens,
    totalTokens: u.total_tokens,
  };
}

async function* _sseStream(
  res: Response,
  ollama: boolean,
  usageRef?: { value?: LLMUsage },
): AsyncGenerator<string, void, void> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error("LLM stream returned no body");
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let payload: string;
      if (ollama) {
        payload = line;
      } else {
        if (!line.startsWith("data:")) continue;
        payload = line.slice(5).trim();
        if (payload === "[DONE]") { buf = ""; break; }
      }
      try {
        const obj = JSON.parse(payload) as {
          choices?: Array<{
            delta?: {
              content?: string | null;
              /** Some OpenAI / proxy variants stream reasoning separately from answer tokens. */
              reasoning?: string | null;
              reasoning_content?: string | null;
            };
            message?: { content?: string };
          }>;
          message?: { content?: string };
          done?: boolean;
          usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
          prompt_eval_count?: number;
          eval_count?: number;
        };
        const usage = parseLlmUsage(obj, ollama);
        if (usage && usageRef) usageRef.value = usage;
        const delta = ollama
          ? (obj.message?.content ?? "")
          : (() => {
              const choice0 = obj.choices?.[0];
              const d = choice0?.delta as Record<string, unknown> | undefined;
              const msg0 = choice0?.message;
              const content =
                (typeof d?.content === "string" ? d.content : "") ||
                (typeof msg0?.content === "string" ? msg0.content : "");
              // Merge reasoning-shaped fields so the ReAct trace / THOUGHT preview can stream like other providers.
              let reasoning = "";
              if (d) {
                for (const k of ["reasoning", "reasoning_content", "thinking"] as const) {
                  const v = d[k];
                  if (typeof v === "string") reasoning += v;
                }
              }
              return reasoning + content;
            })();
        if (delta) yield delta;
      } catch { /* skip malformed chunk */ }
    }
  }
}

/**
 * Like `chat()` but yields each token delta as an async generator so the
 * caller can process tokens incrementally — e.g. to fire a tool as soon as
 * its <tool> XML is complete without waiting for the full response.
 *
 * 429 retries: attempted only when no tokens have been yielded yet (clean
 * slate). Mid-stream 429s are re-thrown because the partial response cannot
 * be cleanly replayed.
 */
export async function* chatStream(
  messages: ChatMessage[],
  opts: LLMOptions = {},
): AsyncGenerator<string, void, void> {
  if (isCursorProvider()) {
    yield* cursorChatStream(messages, opts);
    return;
  }
  let attempt = 0;
  let anyYielded = false;
  for (;;) {
    try {
      const url = endpoint();
      const modelName = model();
      const ollama = isOllamaNative();
      const wireMessages = prepareWireMessages(messages);
      logConfigOnce(url, modelName);
      const skipTemp = !ollama && anthropicOpenAiOmitsTemperature();
      const body = ollama
        ? { model: modelName, messages: wireMessages, stream: true,
            options: { temperature: opts.temperature ?? 0.2, num_predict: opts.maxTokens ?? 1500 } }
        : skipTemp
          ? {
              model: modelName,
              messages: wireMessages,
              max_tokens: opts.maxTokens ?? 1500,
              stream: true,
              stream_options: { include_usage: true },
            }
          : {
              model: modelName,
              messages: wireMessages,
              temperature: opts.temperature ?? 0.2,
              max_tokens: opts.maxTokens ?? 1500,
              stream: true,
              stream_options: { include_usage: true },
            };
      let res: Response;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "text/event-stream", ...authHeader() },
          body: JSON.stringify(body),
          signal: opts.signal,
        });
      } catch (err) {
        if (opts.signal?.aborted) throw err;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let code = "", detail = ""; let cur: any = err;
        for (let i = 0; cur && i < 5; i++) {
          if (typeof cur.code === "string" && /^E[A-Z]+$/.test(cur.code)) { code = cur.code; break; }
          if (!detail && typeof cur.message === "string") detail = cur.message;
          cur = cur.cause;
        }
        const hint = code === "ECONNREFUSED"
          ? `Cannot connect to LLM at ${url}. Is your local model server running? Open ⚙ Settings → Base URL.`
          : code === "ENOTFOUND" || code === "EAI_AGAIN"
          ? `Cannot resolve LLM host for ${url}. Check Settings → Base URL.`
          : `Network error talking to LLM at ${url}: ${detail || (err as Error).message}`;
        throw new Error(hint);
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        let suffix = "";
        if (res.status === 429) {
          const ra = res.headers.get("retry-after")?.trim();
          if (ra && /^\d+$/.test(ra)) suffix += ` [Retry-After: ${ra}]`;
        }
        throw new Error(`LLM ${url} returned ${res.status}: ${text.slice(0, 1200)}${suffix}`);
      }
      const usageRef: { value?: LLMUsage } = {};
      for await (const delta of _sseStream(res, ollama, usageRef)) {
        anyYielded = true;
        yield delta;
      }
      if (usageRef.value) {
        try { opts.onUsage?.(usageRef.value); } catch { /* noop */ }
      }
      return;
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      if (is429ChatError(e) && !anyYielded && attempt < MAX_429_ATTEMPTS - 1) {
        attempt++;
        const waitMs = backoffMsFrom429Error(e);
        logger.warn(`LLM rate limited (429); waiting ~${Math.ceil(waitMs / 1000)}s before chatStream retry (${attempt + 1}/${MAX_429_ATTEMPTS})`);
        await sleepWithSignal(waitMs, opts.signal);
        continue;
      }
      throw e;
    }
  }
}
