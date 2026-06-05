/**
 * Agent Session Manager
 * 
 * Manages background agent sessions that persist independently of client connections.
 * Clients can connect/disconnect/reconnect without affecting running agents.
 */

import type { AgentEvent, AgentMode, AgentRunResult } from "./runner.js";
import { runAgent as runAgentCore } from "./runner.js";
import { logger } from "../utils/logger.js";
import { runWithWorkspace } from "../utils/workspace.js";
import { finalizeRunSnapshot } from "../utils/runSnapshots.js";

export type SessionStatus = "running" | "completed" | "error" | "aborted";

export interface AgentSession {
  id: string;
  task: string;
  mode: AgentMode;
  status: SessionStatus;
  events: AgentEvent[];
  result?: AgentRunResult;
  error?: string;
  createdAt: number;
  completedAt?: number;
  workspace: string;
  images?: { dataUrl: string; name: string }[];
  /** UI chat session — ties run snapshots + checkpoint purge to chat delete. */
  chatId?: string;
}

type SessionListener = (event: AgentEvent) => void;

export type SessionEndedPayload = {
  status: SessionStatus;
  result?: string;
  error?: string;
};

type SessionEndedListener = (end: SessionEndedPayload) => void;

interface SessionState {
  session: AgentSession;
  listeners: Set<SessionListener>;
  endedListeners: Set<SessionEndedListener>;
  abortController: AbortController;
}

/** In-memory store of all sessions, keyed by session ID */
const sessions = new Map<string, SessionState>();

/** Max events to keep per session (prevent memory bloat) */
const MAX_EVENTS_PER_SESSION = 5000;

/** Max completed sessions to keep in memory */
const MAX_COMPLETED_SESSIONS = 50;

/** How long to keep completed sessions (1 hour) */
const COMPLETED_SESSION_TTL_MS = 60 * 60 * 1000;

/**
 * Generate a unique session ID
 */
function generateSessionId(): string {
  return `session-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Clean up old completed sessions
 */
function cleanupOldSessions(): void {
  const now = Date.now();
  const completed: [string, SessionState][] = [];
  
  for (const [id, state] of sessions) {
    if (state.session.status !== "running") {
      completed.push([id, state]);
    }
  }
  
  // Sort by completion time, oldest first
  completed.sort((a, b) => (a[1].session.completedAt ?? 0) - (b[1].session.completedAt ?? 0));
  
  // Remove sessions that are too old or exceed max count
  for (let i = 0; i < completed.length; i++) {
    const [id, state] = completed[i];
    const age = now - (state.session.completedAt ?? state.session.createdAt);
    
    if (age > COMPLETED_SESSION_TTL_MS || i < completed.length - MAX_COMPLETED_SESSIONS) {
      sessions.delete(id);
      logger.info(`Cleaned up old session: ${id}`);
    }
  }
}

/**
 * Start a new background agent session
 */
export function startSession(
  task: string,
  mode: AgentMode,
  workspace: string,
  images?: { dataUrl: string; name: string }[],
  chatId?: string,
): AgentSession {
  const id = generateSessionId();
  
  const session: AgentSession = {
    id,
    task,
    mode,
    status: "running",
    events: [],
    createdAt: Date.now(),
    workspace,
    images,
    chatId,
  };
  
  const abortController = new AbortController();
  const state: SessionState = {
    session,
    listeners: new Set(),
    endedListeners: new Set(),
    abortController,
  };
  
  sessions.set(id, state);
  
  // Run agent in background (don't await)
  runAgentInBackground(state);
  
  // Cleanup old sessions periodically
  cleanupOldSessions();
  
  logger.info(`Started background session: ${id} for task: "${task.slice(0, 50)}..."`);
  
  return session;
}

function notifySessionEnded(state: SessionState): void {
  const { session } = state;
  if (session.status === "running") return;
  const payload: SessionEndedPayload = {
    status: session.status,
    result: session.result?.result,
    error: session.error,
  };
  for (const listener of state.endedListeners) {
    try {
      listener(payload);
    } catch (err) {
      logger.warn("Session ended listener error:", err);
    }
  }
  state.endedListeners.clear();
}

/**
 * Run the agent in background, buffering all events
 */
async function runAgentInBackground(state: SessionState): Promise<void> {
  const { session, abortController } = state;
  
  const onEvent = (event: AgentEvent) => {
    // Buffer event
    if (session.events.length < MAX_EVENTS_PER_SESSION) {
      session.events.push(event);
    }

    // Deliver in emission order. command_chunk must not overtake `action` (setImmediate
    // used to defer other events broke chat live output — chunks rendered before Run row).
    for (const listener of state.listeners) {
      try {
        listener(event);
      } catch (err) {
        logger.warn("Session listener error:", err);
      }
    }
  };
  
  try {
    const result = await runWithWorkspace(session.workspace, async () =>
      runAgentCore({
        task: session.task,
        mode: session.mode,
        runId: session.id,
        chatId: session.chatId,
        signal: abortController.signal,
        onEvent,
        images: session.images,
      }),
    );

    session.status = "completed";
    session.result = result;
    session.completedAt = Date.now();

    // `runAgent` already emitted `final` through onEvent (and it's in session.events).
    // Do not broadcast a second `final` — downstream UIs would append duplicate events.

    logger.info(`Session completed: ${session.id}`);
    
  } catch (err) {
    const msg = (err as Error).message;
    
    if (msg === "aborted") {
      session.status = "aborted";
      session.error = "Aborted by user";
    } else {
      session.status = "error";
      session.error = msg;
    }
    session.completedAt = Date.now();
    
    logger.info(`Session ${session.status}: ${session.id} - ${session.error}`);
  } finally {
    if (session.chatId) {
      void finalizeRunSnapshot(session.chatId, session.id, session.workspace).catch((e) =>
        logger.warn(`runSnapshots finalize: ${(e as Error).message}`),
      );
    }
    notifySessionEnded(state);
  }
}

/**
 * Get a session by ID
 */
export function getSession(id: string): AgentSession | undefined {
  return sessions.get(id)?.session;
}

/**
 * List all sessions for a workspace
 */
export function listSessions(workspace?: string): AgentSession[] {
  const result: AgentSession[] = [];
  
  for (const state of sessions.values()) {
    if (!workspace || state.session.workspace === workspace) {
      result.push(state.session);
    }
  }
  
  // Sort by createdAt descending (newest first)
  result.sort((a, b) => b.createdAt - a.createdAt);
  
  return result;
}

/**
 * Get currently running sessions for a workspace
 */
export function getRunningSessions(workspace?: string): AgentSession[] {
  return listSessions(workspace).filter(s => s.status === "running");
}

/**
 * Subscribe to session events. Returns unsubscribe function.
 * 
 * @param sessionId - Session to subscribe to
 * @param listener - Callback for new events
 * @param replay - If true, replay all buffered events immediately
 */
export function subscribeToSession(
  sessionId: string,
  listener: SessionListener,
  replay = true,
  onEnded?: SessionEndedListener,
): (() => void) | null {
  const state = sessions.get(sessionId);
  if (!state) return null;

  let unsubscribed = false;

  if (onEnded) {
    state.endedListeners.add(onEnded);
    if (state.session.status !== "running") {
      queueMicrotask(() => {
        if (!unsubscribed) onEnded({
          status: state.session.status,
          result: state.session.result?.result,
          error: state.session.error,
        });
      });
    }
  }

  // Replay existing events in chunks so a huge buffer never blocks the event loop
  // (same tick as other API routes / agent ticks).
  if (replay && state.session.events.length > 0) {
    // Strip transient `token` events from replay — they're raw LLM stream
    // deltas useful only while the iteration is in flight. After F5, replaying
    // them dumps the entire buffer into the client's `thinkingRef` and `iter_start`
    // would persist garbage as a malformed thought event.
    const snapshot = state.session.events.filter((e) => e.type !== "token");
    const CHUNK = 200;
    let i = 0;
    const pump = () => {
      if (unsubscribed) return;
      const end = Math.min(i + CHUNK, snapshot.length);
      for (; i < end; i++) {
        try {
          listener(snapshot[i]!);
        } catch {
          /* ignore */
        }
      }
      if (unsubscribed) return;
      if (i < snapshot.length) {
        setImmediate(pump);
      } else {
        state.listeners.add(listener);
      }
    };
    pump();
  } else {
    state.listeners.add(listener);
  }

  return () => {
    unsubscribed = true;
    state.listeners.delete(listener);
    if (onEnded) state.endedListeners.delete(onEnded);
  };
}

/**
 * Abort a running session
 */
export function abortSession(sessionId: string): boolean {
  const state = sessions.get(sessionId);
  if (!state || state.session.status !== "running") {
    return false;
  }
  
  state.abortController.abort();
  logger.info(`Aborted session: ${sessionId}`);
  return true;
}

/**
 * Delete a session (only if not running)
 */
export function deleteSession(sessionId: string): boolean {
  const state = sessions.get(sessionId);
  if (!state) return false;
  
  if (state.session.status === "running") {
    // Must abort first
    return false;
  }
  
  sessions.delete(sessionId);
  return true;
}

/**
 * Get session statistics
 */
export function getStats(): { total: number; running: number; completed: number; error: number } {
  let running = 0, completed = 0, error = 0;
  
  for (const state of sessions.values()) {
    switch (state.session.status) {
      case "running": running++; break;
      case "completed": completed++; break;
      case "error":
      case "aborted": error++; break;
    }
  }
  
  return { total: sessions.size, running, completed, error };
}
