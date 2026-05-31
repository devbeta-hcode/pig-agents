import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import dotenv from "dotenv";
import { hydrateEnvFromProfiles } from "@pig-agents/core";
import { initLlmProfileStorage } from "./initLlmProfiles.js";

let loaded = false;

/** Load LLM/agent settings from userData `.env` (written by in-app Settings). */
export function loadDesktopEnv(): void {
  if (loaded) return;
  loaded = true;

  const userEnv = path.join(app.getPath("userData"), ".env");
  // Tell @pig-agents/core's settings service where to persist config so it
  // writes to the OS app-data dir instead of next to the bundled source.
  process.env.PIG_ENV_FILE = userEnv;
  if (fs.existsSync(userEnv)) {
    dotenv.config({ path: userEnv });
  }

  // Per-provider LLM config lives in electron-store (not repo llm-profiles.json).
  initLlmProfileStorage();
  hydrateEnvFromProfiles();
}