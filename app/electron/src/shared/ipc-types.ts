/** Channels exposed to renderer via preload. */

export type IpcErrorPayload = { code: string; message: string };

export type HealthResult = { ok: true; platform: string; electron: string; ts: number };

export type WorkspaceState = { workspace: string };

export type AppInfo = {
  version: string;
  platform: NodeJS.Platform;
  isDev: boolean;
};

export type PigAgentsApi = {
  ping: () => Promise<HealthResult>;
  getAppInfo: () => Promise<AppInfo>;
  workspaceGet: () => Promise<WorkspaceState>;
  workspaceClear: () => Promise<WorkspaceState>;
  workspacePickFolder: () => Promise<WorkspaceState>;
  onAgentEvent: (cb: (event: unknown) => void) => () => void;
};

declare global {
  interface Window {
    pigAgents: PigAgentsApi;
  }
}

export {};
