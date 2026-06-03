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
    const legacy = [
      "AGENT_TOOL_MODE",
      "LLM_DISABLE_NATIVE_TOOLS",
      "LLM_DISABLE_NATIVE_STREAM",
      "AGENT_USE_NATIVE_TOOLS",
    ];
    let txt = fs.readFileSync(userEnv, "utf8");
    let changed = false;
    for (const line of txt.split(/\r?\n/)) {
      const key = line.split("=")[0]?.trim();
      if (key && legacy.includes(key)) changed = true;
    }
    for (const k of legacy) delete process.env[k];
    if (changed) {
      const lines = txt
        .split(/\r?\n/)
        .filter((line) => {
          if (!line || line.startsWith("#")) return true;
          const key = line.split("=")[0]?.trim();
          return !key || !legacy.includes(key);
        });
      fs.writeFileSync(userEnv, lines.filter((l, i, a) => !(l === "" && i === a.length - 1)).join("\n") + "\n", "utf8");
    }
  }

  // Per-provider LLM config lives in electron-store (not repo llm-profiles.json).
  initLlmProfileStorage();
  hydrateEnvFromProfiles();
}