/**
 * Cursor Cloud Agents API v1 — LLM adapter for Pig Agents Desktop.
 *
 * NOT OpenAI /chat/completions. Base URL must be `https://api.cursor.com/v1`
 * (do not append `/agents` — that path is created per request).
 */
import type { ChatMessage, ContentPart, LLMOptions, LLMUsage } from "./client.js";

const DEFAULT_BASE = "https://api.cursor.com/v1";

export function normalizeCursorBaseUrl(raw: string | undefined): string {
  let b = (raw ?? DEFAULT_BASE).trim().replace(/\/+$/, "");
  b = b.replace(/\/agents$/i, "");
  if (/^https?:\/\/api\.cursor\.com$/i.test(b)) b += "/v1";
  return b || DEFAULT_BASE;
}

function apiKey(): string {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key || key === "xxxx" || key === "your-api-key-here") {
    throw new Error(
      "Cursor API key is not set. Open ⚙ Settings → LLM Provider → Cursor, paste your key from Cursor Dashboard → API Keys.",
    );
  }
  return key;
}

function authHeaders(): Record<string, string> {
  const key = apiKey();
  return {
    Authorization: `Basic ${Buffer.from(`${key}:`).toString("base64")}`,
    "Content-Type": "application/json",
  };
}

function baseUrl(): string {
  return normalizeCursorBaseUrl(process.env.BASE_URL);
}

function modelId(): string | undefined {
  const m = process.env.MODEL?.trim();
  return m || undefined;
}

function messageText(content: string | ContentPart[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}

export function messagesToCursorPrompt(messages: ChatMessage[]): string {
  const blocks: string[] = [];
  for (const m of messages) {
    const body = messageText(m.content).trim();
    if (!body) continue;
    blocks.push(`[${m.role.toUpperCase()}]\n${body}`);
  }
  return blocks.join("\n\n---\n\n");
}

interface CreateAgentResponse {
  agent?: { id?: string };
  run?: { id?: string; agentId?: string };
}

async function createNoRepoAgent(promptText: string, signal?: AbortSignal): Promise<{ agentId: string; runId: string }> {
  const body: Record<string, unknown> = {
    prompt: { text: promptText },
  };
  const mid = modelId();
  if (mid) body.model = { id: mid };

  const res = await fetch(`${baseUrl()}/agents`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
    signal,
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    throw new Error(`Cursor POST /agents ${res.status}: ${text.slice(0, 1200)}`);
  }
  let data: CreateAgentResponse;
  try {
    data = JSON.parse(text) as CreateAgentResponse;
  } catch {
    throw new Error(`Cursor /agents returned invalid JSON: ${text.slice(0, 400)}`);
  }
  const agentId = data.agent?.id ?? data.run?.agentId;
  const runId = data.run?.id;
  if (!agentId || !runId) {
    throw new Error(`Cursor /agents missing agent/run ids: ${text.slice(0, 400)}`);
  }
  return { agentId, runId };
}

async function* parseCursorSseStream(
  res: Response,
  onUsage?: (u: LLMUsage) => void,
): AsyncGenerator<string, void, void> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error("Cursor stream returned no body");
  const decoder = new TextDecoder();
  let buf = "";
  let eventName = "";
  let yielded = false;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trimEnd();
      buf = buf.slice(idx + 1);
      if (!line) {
        eventName = "";
        continue;
      }
      if (line.startsWith("event:")) {
        eventName = line.slice(6).trim();
        continue;
      }
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      try {
        const data = JSON.parse(payload) as Record<string, unknown>;
        if (eventName === "assistant" && typeof data.text === "string" && data.text) {
          yielded = true;
          yield data.text;
        } else if (eventName === "result") {
          if (typeof data.text === "string" && data.text && !yielded) {
            yield data.text;
          }
          if (typeof data.durationMs === "number") {
            onUsage?.({});
          }
        } else if (eventName === "error") {
          const msg = typeof data.message === "string" ? data.message : JSON.stringify(data);
          throw new Error(`Cursor stream error: ${msg}`);
        }
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("Cursor stream error")) throw err;
      }
    }
  }
}

async function streamRun(agentId: string, runId: string, opts: LLMOptions): Promise<string> {
  const url = `${baseUrl()}/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}/stream`;
  const res = await fetch(url, {
    method: "GET",
    headers: {
      ...authHeaders(),
      Accept: "text/event-stream",
    },
    signal: opts.signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Cursor stream ${res.status}: ${text.slice(0, 1200)}`);
  }
  let full = "";
  for await (const delta of parseCursorSseStream(res, opts.onUsage)) {
    full += delta;
    opts.onToken?.(delta);
  }
  return full.trim();
}

export async function cursorChat(messages: ChatMessage[], opts: LLMOptions = {}): Promise<string> {
  const prompt = messagesToCursorPrompt(messages);
  if (!prompt) throw new Error("Cursor: empty prompt");
  const { agentId, runId } = await createNoRepoAgent(prompt, opts.signal);
  const content = await streamRun(agentId, runId, opts);
  if (!content) throw new Error("Cursor agent returned empty content");
  return content;
}

export async function* cursorChatStream(
  messages: ChatMessage[],
  opts: LLMOptions = {},
): AsyncGenerator<string, void, void> {
  const prompt = messagesToCursorPrompt(messages);
  if (!prompt) throw new Error("Cursor: empty prompt");
  const { agentId, runId } = await createNoRepoAgent(prompt, opts.signal);
  const url = `${baseUrl()}/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}/stream`;
  const res = await fetch(url, {
    method: "GET",
    headers: {
      ...authHeaders(),
      Accept: "text/event-stream",
    },
    signal: opts.signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Cursor stream ${res.status}: ${text.slice(0, 1200)}`);
  }
  for await (const delta of parseCursorSseStream(res, opts.onUsage)) {
    yield delta;
  }
}

export async function cursorListModels(
  base?: string,
  apiKeyOverride?: string,
): Promise<{ ok: true; models: string[]; base: string } | { ok: false; error: string; base: string }> {
  const b = normalizeCursorBaseUrl(base || process.env.BASE_URL);
  const listUrl = `${b}/models`;
  try {
    const key = (apiKeyOverride ?? process.env.OPENAI_API_KEY ?? "").trim();
    if (!key) return { ok: false, error: "Cursor API key not set", base: b };
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 12_000);
    const authAttempts = [
      `Basic ${Buffer.from(`${key}:`).toString("base64")}`,
      key.startsWith("Bearer ") ? key : `Bearer ${key}`,
    ];
    let r: Response | null = null;
    for (const authorization of authAttempts) {
      r = await fetch(listUrl, {
        signal: ctl.signal,
        headers: { Authorization: authorization },
      });
      if (r.ok) break;
      if (r.status !== 401 && r.status !== 403) break;
    }
    clearTimeout(t);
    if (!r || !r.ok) {
      const errText = await r?.text().catch(() => "") ?? "";
      return { ok: false, error: `HTTP ${r?.status ?? 0}: ${errText.slice(0, 200)}`, base: b };
    }
    const data = (await r.json()) as {
      items?: { id?: string; aliases?: string[] }[];
    };
    const models: string[] = [];
    for (const item of data.items ?? []) {
      if (item.id) models.push(item.id);
      for (const a of item.aliases ?? []) {
        if (a && !models.includes(a)) models.push(a);
      }
    }
    models.sort((a, b) => a.localeCompare(b));
    return { ok: true, models, base: b };
  } catch (err) {
    return { ok: false, error: (err as Error).message, base: b };
  }
}
