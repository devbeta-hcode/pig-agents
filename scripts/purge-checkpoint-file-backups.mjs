/**
 * Delete ALL full-workspace file copies in ~/.pig-agents/backups (keeps git checkpoints in repos).
 * Use this if disk filled — these copies were created by the old checkpoint fallback, not agents.
 *
 *   node scripts/purge-checkpoint-file-backups.mjs --all
 *   node scripts/purge-checkpoint-file-backups.mjs --workspace "D:\path\to\project"
 */
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const coreEntry = path.join(repoRoot, "app", "core", "dist", "index.js");

function parseArgs() {
  const args = process.argv.slice(2);
  let workspace = repoRoot;
  let all = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--all") all = true;
    else if (args[i] === "--workspace" && args[i + 1]) workspace = path.resolve(args[++i]);
  }
  return { workspace, all };
}

async function purgeAllOnDisk() {
  const root = path.join(os.homedir(), ".pig-agents", "backups");
  if (!fs.existsSync(root)) {
    console.log("No", root);
    return;
  }
  let n = 0;
  for (const hashDir of fs.readdirSync(root)) {
    const base = path.join(root, hashDir);
    if (!fs.statSync(base).isDirectory()) continue;
    for (const ent of fs.readdirSync(base)) {
      const p = path.join(base, ent);
      if (ent.startsWith("cp-") && fs.statSync(p).isDirectory()) {
        fs.rmSync(p, { recursive: true, force: true });
        n++;
      }
    }
  }
  console.log(`Removed ${n} file backup folder(s) under ${root}`);
}

async function main() {
  const { workspace, all } = parseArgs();
  if (all) {
    await purgeAllOnDisk();
    return;
  }
  if (!fs.existsSync(coreEntry)) {
    console.error("Build core first: npm run build --workspace @pig-agents/core");
    process.exit(1);
  }
  const core = await import(new URL(`file:///${coreEntry.replace(/\\/g, "/")}`));
  core.setWorkspace(workspace);
  const r = await core.services.checkpointPurgeFileBackups();
  console.log(r.freedNote);
  console.log("Removed dirs:", r.removedDirs);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
