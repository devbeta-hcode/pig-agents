import type { LlmProfilesFile } from "./profiles.js";

/** Pluggable persistence for LLM profiles (Electron: electron-store; tests: in-memory). */
export interface ProfileStorage {
  read(): LlmProfilesFile;
  write(data: LlmProfilesFile): void;
  /** Human-readable location for Settings UI (e.g. store file path). */
  location(): string;
}

let storage: ProfileStorage | null = null;

export function setProfileStorage(next: ProfileStorage): void {
  storage = next;
}

export function getProfileStorage(): ProfileStorage {
  if (!storage) throw new Error("LLM profile storage not initialized");
  return storage;
}

export function isProfileStorageReady(): boolean {
  return storage !== null;
}
