/**
 * Harden agent policy for the workspace folder YOU chose (Open Folder in the app).
 * Does NOT hardcode any drive path — workspace comes from --workspace (required)
 * or defaults to the repo root when you run this from pig-agents-desktop.
 *
 * Usage (one or more project folders — matches multi-agent / multi-workspace):
 *   node scripts/apply-safety-now.mjs --workspace "E:\a\proj1" --workspace "F:\copy\proj2"
 *
 * Multi-agent: each background run stores its own workspace path; policy lives in
 * that folder's .pig-agents/policy.json. Run this script once per folder you use.
 *
 * Optional (power users only):
 *   --allowed-root "E:\projects"  → also set ALLOWED_WORKSPACE_ROOT in user .env
 *   --set-workspace-root          → write WORKSPACE_ROOT=... to user .env (main process default)
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs() {
  const args = process.argv.slice(2);
  const workspaces = [];
  let allowedRoot = "";
  let setWorkspaceRoot = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--workspace" && args[i + 1]) workspaces.push(path.resolve(args[++i]));
    else if (args[i] === "--allowed-root" && args[i + 1]) allowedRoot = path.resolve(args[++i]);
    else if (args[i] === "--set-workspace-root") setWorkspaceRoot = true;
  }
  if (workspaces.length === 0) workspaces.push(repoRoot);
  return { workspaces: [...new Set(workspaces)], allowedRoot, setWorkspaceRoot };
}

function appDataEnvPath() {
  const base =
    process.platform === "win32"
      ? process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming")
      : process.platform === "darwin"
        ? path.join(os.homedir(), "Library", "Application Support")
        : path.join(os.homedir(), ".config");
  return path.join(base, "pig-agents-desktop", ".env");
}

async function readEnvLines(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return (await fsp.readFile(filePath, "utf8")).split(/\r?\n/);
}

async function writeEnvLines(filePath, lines) {
  const out = lines.filter((l, i, a) => !(l === "" && i === a.length - 1)).join("\n") + "\n";
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, out, "utf8");
}

async function upsertEnvLine(filePath, key, value) {
  const lines = await readEnvLines(filePath);
  const prefix = `${key}=`;
  let found = false;
  const next = lines.map((line) => {
    if (line.startsWith(prefix)) {
      found = true;
      return `${prefix}${value}`;
    }
    return line;
  });
  if (!found) next.push(`${prefix}${value}`);
  await writeEnvLines(filePath, next);
}

async function removeEnvKeys(filePath, keys) {
  const lines = await readEnvLines(filePath);
  const drop = new Set(keys);
  const next = lines.filter((line) => {
    const k = line.split("=")[0]?.trim();
    return !k || !drop.has(k);
  });
  await writeEnvLines(filePath, next);
}

async function findPolicyUnderWorkspace(workspace) {
  const found = new Set();
  const pol = path.join(workspace, ".pig-agents", "policy.json");
  if (fs.existsSync(pol)) found.add(pol);
  if (!fs.existsSync(workspace)) return [...found];
  const stack = [workspace];
  let depth = 0;
  while (stack.length && depth < 6) {
    const n = stack.length;
    depth++;
    for (let i = 0; i < n; i++) {
      const dir = stack.pop();
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const ent of entries) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          if (ent.name === "node_modules" || ent.name === ".git") continue;
          stack.push(full);
        } else if (ent.name === "policy.json" && full.includes(`${path.sep}.pig-agents${path.sep}`)) {
          found.add(full);
        }
      }
    }
  }
  return [...found];
}

async function hardenPolicyFile(policyPath) {
  let p;
  try {
    p = JSON.parse(await fsp.readFile(policyPath, "utf8"));
  } catch (err) {
    console.warn(`  skip (invalid JSON): ${policyPath}`, err);
    return;
  }
  p.autoApprove = false;
  p.autoApproveWeb = false;
  p.autoApproveDelete = false;
  if (!Array.isArray(p.trusted)) p.trusted = [];
  const risky = p.trusted.filter((t) =>
    /^(rd|rmdir|del\s|rm\s+-[a-z]*f|Remove-Item)/i.test(String(t)),
  );
  if (risky.length) {
    console.log(`  removed risky trusted patterns from ${policyPath}:`, risky);
    p.trusted = p.trusted.filter((t) => !risky.includes(t));
  }
  await fsp.writeFile(policyPath, JSON.stringify(p, null, 2) + "\n", "utf8");
  console.log(`  policy OK: ${policyPath}`);
}

async function hardenOneWorkspace(workspace, core) {
  if (!fs.existsSync(workspace) || !fs.statSync(workspace).isDirectory()) {
    console.error(`[safety] Skip (not a directory): ${workspace}`);
    return false;
  }
  console.log("[safety] Workspace:", workspace);
  if (core) {
    const { services, setWorkspace } = core;
    setWorkspace(workspace);
    await services.policyAutoApprove(false);
    await services.policyAutoApproveWeb(false);
    await services.policyAutoApproveDelete(false);
    console.log("[safety] Policy:", path.join(workspace, ".pig-agents", "policy.json"));
  }
  const policies = await findPolicyUnderWorkspace(workspace);
  for (const f of policies) await hardenPolicyFile(f);
  return true;
}

async function main() {
  const { workspaces, allowedRoot, setWorkspaceRoot } = parseArgs();
  const envPath = appDataEnvPath();

  await removeEnvKeys(envPath, ["ALLOWED_WORKSPACE_ROOT", "WORKSPACE_ROOT"]);
  if (allowedRoot) {
    console.log("[safety] Optional allowed root:", allowedRoot);
    await upsertEnvLine(envPath, "ALLOWED_WORKSPACE_ROOT", allowedRoot);
  }
  if (setWorkspaceRoot && workspaces.length === 1) {
    console.log("[safety] Setting WORKSPACE_ROOT in .env");
    await upsertEnvLine(envPath, "WORKSPACE_ROOT", workspaces[0]);
  } else if (setWorkspaceRoot) {
    console.warn("[safety] --set-workspace-root ignored when multiple --workspace (use Open Folder in app).");
  } else {
    console.log("[safety] Not writing WORKSPACE_ROOT — Open Folder picks the active project.");
  }

  const coreEntry = path.join(repoRoot, "app", "core", "dist", "index.js");
  const core = fs.existsSync(coreEntry) ? await import(pathToFileUrl(coreEntry)) : null;
  if (!core) console.warn("[safety] Core not built — run: npm run build --workspace @pig-agents/core");

  const okPaths = [];
  for (const ws of workspaces) {
    if (await hardenOneWorkspace(ws, core)) okPaths.push(ws);
  }
  if (okPaths.length === 0) {
    console.error("  Pass: node scripts/apply-safety-now.mjs --workspace \"<path>\" [--workspace \"<other>\"]");
    process.exit(1);
  }

  const hintPath = path.join(path.dirname(envPath), "SAFETY-APPLIED.txt");
  const hint = [
    `Applied: ${new Date().toISOString()}`,
    `workspaces=${okPaths.join("; ")}`,
    allowedRoot ? `ALLOWED_WORKSPACE_ROOT=${allowedRoot}` : "ALLOWED_WORKSPACE_ROOT=(not set)",
    "",
    "Multi-agent: each run uses the workspace it started with; badge lists runs per folder.",
    "Open Folder = UI focus; background agents on other folders keep their path.",
    "",
    "Per project: node scripts/apply-safety-now.mjs --workspace \"<path>\" ...",
  ].join("\n");
  await fsp.writeFile(hintPath, hint, "utf8");
  console.log("[safety] Wrote", hintPath);
  console.log(hint);
}

function pathToFileUrl(p) {
  const resolved = path.resolve(p).replace(/\\/g, "/");
  return new URL(`file:///${resolved}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
