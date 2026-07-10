#!/usr/bin/env node
/**
 * Linux package layout: shell launcher `pig-agents-desktop` + binary `pig-agents-desktop-bin`.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const launcherSrc = path.join(root, "scripts/linux/pig-agents-launcher.sh");

export default async function afterPack(context) {
  if (context.electronPlatformName !== "linux") return;

  const appDir = context.appOutDir;
  const binPath = path.join(appDir, "pig-agents-desktop");
  const binReal = path.join(appDir, "pig-agents-desktop-bin");

  if (!fs.existsSync(binPath)) {
    throw new Error(`[after-pack-linux] missing binary: ${binPath}`);
  }

  fs.renameSync(binPath, binReal);
  fs.copyFileSync(launcherSrc, binPath);
  fs.chmodSync(binPath, 0o755);
  console.log("[after-pack-linux] installed shell launcher");
}
