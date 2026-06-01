import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { setProfileStorage, type LlmProfilesFile } from "@pig-agents/core";
import {
  llmProfilesStorePath,
  readLlmProfilesFromStore,
  writeLlmProfilesToStore,
} from "./llmProfilesStore.js";

const MIGRATION_FLAG = "llm-profiles.migrated-from-repo.v1";

/** One-time migration source: old dev file at `app/llm-profiles.json`. */
function legacyRepoProfilesPath(): string {
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  return path.resolve(here, "../../llm-profiles.json");
}

function readLegacyFile(filePath: string): LlmProfilesFile | null {
  try {
    const txt = fs.readFileSync(filePath, "utf8");
    const j = JSON.parse(txt) as LlmProfilesFile;
    if (j?.version !== 1 || typeof j.profiles !== "object" || j.profiles === null) return null;
    return j;
  } catch {
    return null;
  }
}

function migrateLegacyProfilesOnce(): void {
  const cur = readLlmProfilesFromStore();
  if (Object.keys(cur.profiles).length > 0) return;

  const legacy = readLegacyFile(legacyRepoProfilesPath());
  if (!legacy || Object.keys(legacy.profiles).length === 0) return;

  writeLlmProfilesToStore(legacy);
  try {
    const marker = `${llmProfilesStorePath()}.${MIGRATION_FLAG}`;
    fs.writeFileSync(marker, new Date().toISOString(), "utf8");
  } catch { /* non-fatal */ }
}

/** Wire electron-store as the sole LLM profile backend (no repo JSON file). */
export function initLlmProfileStorage(): void {
  migrateLegacyProfilesOnce();

  setProfileStorage({
    read: readLlmProfilesFromStore,
    write: writeLlmProfilesToStore,
    location: llmProfilesStorePath,
  });
}
