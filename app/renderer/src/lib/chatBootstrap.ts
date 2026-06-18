import type { ChatSessionMeta } from "./api";
import type { ChatSession } from "./sessions";

export interface ChatBootstrapCache {
  chatList: ChatSessionMeta[];
  activeSessionId: string;
  activeSession: ChatSession | null;
  savedAt: number;
}

function cacheKey(workspace: string): string {
  const hash = workspace
    .split("")
    .reduce((a, b) => ((a << 5) - a + b.charCodeAt(0)) | 0, 0)
    .toString(36);
  return `pig-agents.chat.bootstrap.v1::${hash}`;
}

export function readChatBootstrap(workspace: string): ChatBootstrapCache | null {
  if (!workspace) return null;
  try {
    const raw = sessionStorage.getItem(cacheKey(workspace));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ChatBootstrapCache;
    if (!parsed || !Array.isArray(parsed.chatList) || typeof parsed.activeSessionId !== "string") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function writeChatBootstrap(workspace: string, data: Omit<ChatBootstrapCache, "savedAt">): void {
  if (!workspace) return;
  const payload: ChatBootstrapCache = { ...data, savedAt: Date.now() };
  try {
    sessionStorage.setItem(cacheKey(workspace), JSON.stringify(payload));
  } catch {
    try {
      sessionStorage.setItem(
        cacheKey(workspace),
        JSON.stringify({ ...payload, activeSession: null }),
      );
    } catch {
      /* quota / private mode */
    }
  }
}

/** IPC can fail briefly while Electron main is still starting — retry before giving up. */
export async function rpcWithRetry<T>(
  fn: () => Promise<T>,
  opts?: { attempts?: number; delayMs?: number },
): Promise<T> {
  const attempts = opts?.attempts ?? 4;
  const delayMs = opts?.delayMs ?? 350;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i + 1 < attempts) {
        await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
      }
    }
  }
  throw lastErr;
}

export function isChatNotFoundError(err: unknown): boolean {
  const msg = (err as Error)?.message ?? String(err);
  return /not found|ENOENT/i.test(msg);
}
