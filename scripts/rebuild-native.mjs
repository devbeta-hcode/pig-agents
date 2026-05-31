#!/usr/bin/env node
/**
 * Rebuild native addons (node-pty) for the Electron version in app/electron.
 * Windows: needs VS 2022 Build Tools (C++ workload). If MSB8040 (Spectre libs),
 * this script passes SpectreMitigation=false — same as a manual node-gyp rebuild.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const electronDir = path.join(root, "app", "electron");

const env = {
  ...process.env,
  npm_config_msbuild_args: "/p:SpectreMitigation=false",
};

console.log("[rebuild-native] Rebuilding node-pty for Electron (this may take ~1 min)…");

const r = spawnSync(
  "npx",
  ["@electron/rebuild", "-f", "-w", "node-pty"],
  { cwd: electronDir, env, stdio: "inherit", shell: true },
);

if (r.status !== 0) {
  console.error("[rebuild-native] FAILED — is Visual Studio Build Tools (C++) installed?");
  process.exit(r.status ?? 1);
}
console.log("[rebuild-native] OK");
