/**
 * Claude Code provider — routes Pig Agents' LLM calls through the official
 * Claude Agent SDK (`@anthropic-ai/claude-agent-sdk` `query()`), driving Claude
 * Code headlessly as a plain text generator (its own tools disabled, single
 * turn, Pig Agents' system prompt). Auth: an API key if the user configured one,
 * otherwise the machine's `claude login` (Pro/Max subscription).
 *
 * The SDK spawns the bundled Claude Code CLI, so each call is a subprocess —
 * slower than a raw HTTP API call. Loaded lazily (dynamic import) so it never
 * affects startup or other providers.
 */
import type { ChatMessage, LLMOptions, ContentPart } from "./client.js";
import { getWorkspace } from "../utils/workspace.js";

const SDK = "@anthropic-ai/claude-agent-sdk";

function messageText(content: string | ContentPart[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((p): p is Extract<ContentPart, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}

interface ParsedImage { media_type: string; data: string }

/** `data:image/png;base64,…` → { media_type, base64 data }. */
function parseDataUrl(url: string): ParsedImage | null {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(url);
  return m ? { media_type: m[1], data: m[2] } : null;
}

function collectImages(content: string | ContentPart[]): ParsedImage[] {
  if (typeof content === "string") return [];
  const out: ParsedImage[] = [];
  for (const p of content) {
    if (p.type === "image_url") {
      const img = parseDataUrl(p.image_url.url);
      if (img) out.push(img);
    }
  }
  return out;
}

/** Pig Agents sends `[system, user]`; map to the SDK's systemPrompt + prompt (+ images). */
function buildPrompt(messages: ChatMessage[]): { system: string; prompt: string; images: ParsedImage[] } {
  const sys: string[] = [];
  const turns: string[] = [];
  const images: ParsedImage[] = [];
  for (const m of messages) {
    if (m.role !== "system") images.push(...collectImages(m.content ?? ""));
    const body = messageText(m.content ?? "").trim();
    if (!body) continue;
    if (m.role === "system") sys.push(body);
    else if (m.role === "assistant") turns.push(`[ASSISTANT]\n${body}`);
    else turns.push(body);
  }
  const prompt = turns.length === 1 ? turns[0] : turns.join("\n\n---\n\n");
  return { system: sys.join("\n\n"), prompt, images };
}

function claudeModel(): string | undefined {
  const m = process.env.MODEL?.trim();
  return m && m.length > 0 ? m : undefined;
}

/** API key if configured (→ API billing); else inherit env so the SDK uses `claude login`. */
function authEnv(): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;
  const key = process.env.OPENAI_API_KEY?.trim();
  if (key && key.length > 0 && key !== "local") env.ANTHROPIC_API_KEY = key;
  return env;
}

interface SdkStreamEvent {
  type: string;
  event?: { type?: string; delta?: { type?: string; text?: string } };
  message?: { content?: Array<{ type?: string; text?: string }> };
  subtype?: string;
}

/** Stream assistant text deltas from one headless Claude Code turn. */
async function* streamQuery(messages: ChatMessage[], opts: LLMOptions): AsyncGenerator<string, void, void> {
  const mod = (await import(SDK)) as { query: (p: unknown) => AsyncIterable<SdkStreamEvent> & { interrupt?: () => void } };
  const { system, prompt, images } = buildPrompt(messages);
  // Vision works: pass a structured user message (text + base64 image blocks) via
  // the SDK's async-iterable prompt form. (Tiny/degenerate images can still be
  // rejected by Claude Code's image pre-processing, but real screenshots work.)
  let promptArg: unknown = prompt;
  if (images.length > 0) {
    async function* userMessages(): AsyncGenerator<unknown, void, void> {
      yield {
        type: "user",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [
            { type: "text", text: prompt },
            ...images.map((im) => ({
              type: "image",
              source: { type: "base64", media_type: im.media_type, data: im.data },
            })),
          ],
        },
      };
    }
    promptArg = userMessages();
  }
  const q = mod.query({
    prompt: promptArg,
    options: {
      systemPrompt: system || undefined,
      allowedTools: [],
      maxTurns: 1,
      includePartialMessages: true,
      model: claudeModel(),
      cwd: getWorkspace() || undefined,
      env: authEnv(),
      permissionMode: "bypassPermissions",
    },
  });

  let streamed = false;
  for await (const m of q) {
    if (opts.signal?.aborted) {
      try { q.interrupt?.(); } catch { /* noop */ }
      throw new Error("aborted");
    }
    if (m.type === "stream_event") {
      const d = m.event?.delta;
      if (m.event?.type === "content_block_delta" && d?.type === "text_delta" && typeof d.text === "string") {
        streamed = true;
        try { opts.onToken?.(d.text); } catch { /* noop */ }
        yield d.text;
      }
    } else if (m.type === "assistant" && !streamed) {
      for (const b of m.message?.content ?? []) {
        if (b?.type === "text" && typeof b.text === "string" && b.text) {
          try { opts.onToken?.(b.text); } catch { /* noop */ }
          yield b.text;
        }
      }
    } else if (m.type === "result") {
      if (m.subtype && m.subtype !== "success") {
        throw new Error(`Claude Code SDK ${m.subtype} (check your subscription / API key, or run 'claude login').`);
      }
      return;
    }
  }
}

export async function* claudeAgentChatStream(
  messages: ChatMessage[],
  opts: LLMOptions = {},
): AsyncGenerator<string, void, void> {
  yield* streamQuery(messages, opts);
}

export async function claudeAgentChat(messages: ChatMessage[], opts: LLMOptions = {}): Promise<string> {
  let full = "";
  for await (const delta of streamQuery(messages, opts)) full += delta;
  return full;
}

/** Official model list for this machine's Claude Code (subscription/API), via the SDK. */
export async function claudeAgentModels(): Promise<{ value: string; label: string }[]> {
  const mod = (await import(SDK)) as {
    query: (p: unknown) => {
      supportedModels: () => Promise<Array<{ value: string; displayName?: string; description?: string }>>;
      interrupt?: () => void;
    };
  };
  // Streaming-input prompt that stays open so we can call the control method
  // without actually running an agent turn.
  async function* keepOpen(): AsyncGenerator<never, void, void> {
    await new Promise<void>((r) => setTimeout(r, 15_000));
  }
  const q = mod.query({ prompt: keepOpen(), options: { allowedTools: [], env: authEnv() } });
  try {
    const models = await q.supportedModels();
    return models.map((m) => {
      // description is like "Opus 4.8 · Most capable" → use the version part as label.
      const ver = (m.description ?? "").split("·")[0].trim();
      // "default" resolves to whatever the account's default is (often the same as
      // another row) — keep it distinct so the list doesn't show two identical labels.
      if (m.value === "default") {
        return { value: m.value, label: ver ? `Default (${ver})` : m.displayName || "Default" };
      }
      return { value: m.value, label: ver || m.displayName || m.value };
    });
  } finally {
    try { q.interrupt?.(); } catch { /* noop */ }
  }
}
