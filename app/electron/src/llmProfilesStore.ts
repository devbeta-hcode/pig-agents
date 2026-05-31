import Store from "electron-store";
import type { LlmProfilesFile } from "@pig-agents/core";

const EMPTY: LlmProfilesFile = { version: 1, profiles: {} };

const store = new Store<{ file: LlmProfilesFile }>({
  name: "llm-profiles",
  defaults: { file: EMPTY },
});

function normalize(raw: unknown): LlmProfilesFile {
  const j = raw as LlmProfilesFile;
  if (j?.version !== 1 || typeof j.profiles !== "object" || j.profiles === null) {
    return { version: 1, profiles: {} };
  }
  return j;
}

export function readLlmProfilesFromStore(): LlmProfilesFile {
  return normalize(store.get("file"));
}

export function writeLlmProfilesToStore(data: LlmProfilesFile): void {
  store.set("file", normalize(data));
}

export function llmProfilesStorePath(): string {
  return store.path;
}
