/**
 * @pig-agents/core — public surface for the Electron main process.
 *
 * Everything the desktop app needs, with NO HTTP/Express/WebSocket transport.
 * - `services`: request/response style functions (call directly over IPC).
 * - streaming primitives: callback-based agent runs, sessions, command log.
 * - terminal + fs watcher + workspace helpers.
 */

import * as services from "./services.js";
export { services };

// ---- Streaming / long-lived primitives ------------------------------------
export { runAgent } from "./agent/runner.js";
export type { AgentEvent, AgentMode, AgentRunOptions, AgentRunResult } from "./agent/runner.js";
export {
  subscribeToSession,
  getSession,
} from "./agent/sessionManager.js";
export {
  subscribeAgentCommands,
  listAgentCommands,
  listPendingCommands,
} from "./agent/commandLog.js";

// ---- Workspace + watcher --------------------------------------------------
export {
  getWorkspace,
  setWorkspace,
  validateWorkspacePath,
  runWithWorkspace,
} from "./utils/workspace.js";
export { workspaceWatcher, type WorkspaceChangesPayload, type FsChangeEvent } from "./utils/watcher.js";

// ---- Terminal -------------------------------------------------------------
export { createPty, type PtyLike } from "./tools/terminal.js";

// ---- Approvals (agent gate) -----------------------------------------------
export { resolveApproval, type ApprovalDecision } from "./utils/approvals.js";

// ---- Logger ---------------------------------------------------------------
export { logger } from "./utils/logger.js";

// ---- LLM profiles (storage wired by Electron main on startup) -----------
export {
  setProfileStorage,
  getProfileStorage,
  isProfileStorageReady,
  type ProfileStorage,
} from "./llm/profileStorage.js";
export {
  hydrateEnvFromProfiles,
  legacyRepoProfilesPath,
  profilesStorageLocation,
  type LlmProfilesFile,
  type ProfileSlot,
} from "./llm/profiles.js";

// ---- Browser (Electron BrowserView driver) --------------------------------
export { setBrowserDriver, getBrowserDriver, type BrowserDriver } from "./browser/driver.js";
export { browserSession, type ElementInfo } from "./browser/session.js";
