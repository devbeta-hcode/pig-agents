// Per-workspace command-approval policy.
//
// The agent's `run_command` tool used to forward anything the LLM emitted to
// `bash -lc`. With the policy engine in place, every command runs through
// `decide(cmd)` first:
//
//   1. Match against the deny-list  → BLOCK   (never runs, agent gets error)
//   2. Match against the allow-list  → ALLOW  (runs immediately, no prompt)
//   3. Otherwise                     → ASK    (frontend modal pops up; user
//                                              can Allow once / Allow always
//                                              / Deny / Edit & allow)
//
// "Allow always" decisions get appended to the workspace's allow-list so the
// user only sees each command once. The whole policy lives at
//   <workspace>/.pig-agents/policy.json
// (same directory as checkpoint metadata, also covered by .git/info/exclude).
//
// Pattern syntax is intentionally tiny: `*` is a greedy wildcard, everything
// else is a literal. Anchored at both ends. This is enough to express
// `git push --force*`, `npm *`, `rm -rf /*`, etc., without dragging in a
// glob library or letting the LLM craft an evil regex.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { getWorkspace } from "./workspace.js";
import { logger } from "./logger.js";

const POLICY_DIR = ".pig-agents";
const POLICY_FILE = "policy.json";

export type Decision = "allow" | "deny" | "ask";

export interface Policy {
  version: 1;
  /** Hard-block patterns. Match → BLOCK regardless of allow list. */
  deny: string[];
  /** Auto-approve patterns. */
  allow: string[];
  /** Patterns the user has clicked "Allow always" on this session. */
  trusted: string[];
  /**
   * "YOLO mode" — when true, every command that isn't on the deny-list runs
   * without prompting. Deny patterns still hard-block (so `rm -rf /`, `sudo`,
   * force-push, etc. remain protected). The intent is "I trust this agent for
   * the next stretch, stop nagging" rather than "remove all guardrails".
   */
  autoApprove?: boolean;
  /**
   * Web-tool auto-approve. When true, `web_fetch` / `web_search` skip the
   * approval modal. SSRF / loopback / private-network hosts are still
   * rejected at the tool layer regardless of this flag.
   */
  autoApproveWeb?: boolean;
  /** When true, `delete_path` skips the approval modal (still sandboxed to workspace). */
  autoApproveDelete?: boolean;
}

export const DEFAULT_POLICY: Policy = {
  version: 1,
  deny: [
    // Filesystem destruction
    "rm -rf /*",
    "rm -rf ~*",
    "rm -rf .*",
    "rm -rf $HOME*",
    "rm -fr /*",
    "* | rm -rf*",
    // Windows recursive delete (use delete_file tool / file tree instead)
    "rd /s /q*",
    "rmdir /s /q*",
    "del /f /s /q*",
    "Remove-Item*-Recurse*",
    // Disk overwrites
    "dd if=*",
    "mkfs*",
    "mkswap*",
    // Privilege escalation
    "sudo*",
    "su -*",
    "doas*",
    // Pipe-to-shell from network
    "curl* | sh*",
    "curl* | bash*",
    "wget* | sh*",
    "wget* | bash*",
    // Fork bomb / system kill
    ":() { :|: & };:",
    "kill -9 -1*",
    "shutdown*",
    "reboot*",
    "halt*",
    "poweroff*",
    // Permission nukes
    "chmod -R 777 /*",
    "chmod 777 /*",
    "chown -R * /*",
    // Git destruction (force-push, hard reset to remote, etc.)
    "git push --force*",
    "git push -f *",
    "git push --mirror*",
    "git reset --hard origin*",
    "git reflog expire*",
    "git filter-branch*",
    // Package publication (you don't want the agent shipping to npm by accident)
    "npm publish*",
    "yarn publish*",
    "pnpm publish*",
  ],
  allow: [
    // Read-only inspection
    "ls", "ls *",
    "pwd",
    "cat *",
    "head *", "tail *",
    "echo *",
    "wc *",
    "file *",
    "which *",
    "type *",
    "env",
    "stat *",
    "tree", "tree *",

    // Search
    "rg *", "grep *", "find *",

    // Filesystem creation (no recursive removes, no /)
    "mkdir *",
    "touch *",
    "cp *", "mv *",

    // Git read ops
    "git status*", "git diff*", "git log*", "git show*",
    "git branch*", "git remote*", "git config --get*",
    "git stash list*", "git rev-parse*",
    "git fetch*", "git pull --ff-only*",

    // Build / test / format runners
    "npm install", "npm i", "npm i *", "npm install *",
    "npm run *", "npm test*", "npm exec *", "npx *",
    "pnpm install", "pnpm i", "pnpm install *",
    "pnpm run *", "pnpm test*", "pnpm exec *", "pnpx *",
    "yarn install", "yarn", "yarn add *", "yarn run *", "yarn test*",
    "tsc", "tsc *",
    "eslint *", "prettier *",

    // Language runners (no `--exec arbitrary string`, just files)
    "node *", "deno run *", "bun run *",
    "python *", "python3 *", "pip install *", "pip3 install *",
    "pytest", "pytest *",
    "go test *", "go build *", "go run *",
    "cargo build*", "cargo test*", "cargo run*", "cargo check*",
    "make", "make *",
  ],
  trusted: [],
};

// ---------------------------------------------------------------------------
// Pattern matching
// ---------------------------------------------------------------------------

/** Compile a tiny glob: only `*` is wild, everything else is literal. */
function compile(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function anyMatch(cmd: string, patterns: string[]): string | null {
  const trimmed = cmd.trim();
  for (const p of patterns) {
    try {
      if (compile(p).test(trimmed)) return p;
    } catch { /* malformed user-edited pattern — ignore */ }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Disk IO
// ---------------------------------------------------------------------------

function policyPath(ws: string): string {
  return path.join(ws, POLICY_DIR, POLICY_FILE);
}

async function ensureDir(ws: string): Promise<void> {
  await fsp.mkdir(path.join(ws, POLICY_DIR), { recursive: true });
}

export async function loadPolicy(workspace?: string): Promise<Policy> {
  const ws = workspace ?? getWorkspace();
  try {
    const txt = await fsp.readFile(policyPath(ws), "utf8");
    const obj = JSON.parse(txt) as Partial<Policy>;
    if (obj && obj.version === 1) {
      return {
        version: 1,
        deny: Array.isArray(obj.deny) ? obj.deny : DEFAULT_POLICY.deny,
        allow: Array.isArray(obj.allow) ? obj.allow : DEFAULT_POLICY.allow,
        trusted: Array.isArray(obj.trusted) ? obj.trusted : [],
        autoApprove: !!obj.autoApprove,
        autoApproveWeb: !!obj.autoApproveWeb,
        autoApproveDelete: !!obj.autoApproveDelete,
      };
    }
  } catch {
    // Missing file is the common case: we lazily seed defaults.
  }
  // Seed defaults to disk on first read so the user can edit them.
  if (fs.existsSync(ws)) {
    try {
      await ensureDir(ws);
      await fsp.writeFile(policyPath(ws), JSON.stringify(DEFAULT_POLICY, null, 2));
    } catch (err) {
      logger.warn(`policy: failed to seed default policy: ${(err as Error).message}`);
    }
  }
  return { ...DEFAULT_POLICY, trusted: [] };
}

/**
 * Flip the "auto-approve everything (except deny-list)" switch and persist.
 * Returns the updated policy.
 */
export async function setAutoApprove(value: boolean, workspace?: string): Promise<Policy> {
  const ws = workspace ?? getWorkspace();
  const p = await loadPolicy(ws);
  if (!!p.autoApprove === !!value) return p;
  p.autoApprove = !!value;
  await savePolicy(p, ws);
  return p;
}

/** Same as `setAutoApprove` but for the web tools (`web_fetch` / `web_search`). */
export async function setAutoApproveWeb(value: boolean, workspace?: string): Promise<Policy> {
  const ws = workspace ?? getWorkspace();
  const p = await loadPolicy(ws);
  if (!!p.autoApproveWeb === !!value) return p;
  p.autoApproveWeb = !!value;
  await savePolicy(p, ws);
  return p;
}

/** When true, agent `delete_path` runs without the delete approval modal. */
export async function setAutoApproveDelete(value: boolean, workspace?: string): Promise<Policy> {
  const ws = workspace ?? getWorkspace();
  const p = await loadPolicy(ws);
  if (!!p.autoApproveDelete === !!value) return p;
  p.autoApproveDelete = !!value;
  await savePolicy(p, ws);
  return p;
}

export function deletePathPolicyKey(relPath: string): string {
  return `delete_path:${relPath.replace(/\\/g, "/").trim()}`;
}

/** Returns matched pattern if this delete path is pre-approved. */
export function matchedDeletePathPolicy(relPath: string, p: Policy): string | null {
  const key = deletePathPolicyKey(relPath);
  return (
    anyMatch(key, p.allow) ??
    anyMatch(key, p.trusted) ??
    anyMatch("delete_path:*", p.allow) ??
    anyMatch("delete_path:*", p.trusted)
  );
}

export async function savePolicy(p: Policy, workspace?: string): Promise<void> {
  const ws = workspace ?? getWorkspace();
  await ensureDir(ws);
  await fsp.writeFile(policyPath(ws), JSON.stringify(p, null, 2));
}

/**
 * Append a single pattern to the trusted list and persist. No-op if the
 * pattern (or an equivalent) is already trusted/allowed.
 */
export async function trust(pattern: string, workspace?: string): Promise<Policy> {
  const ws = workspace ?? getWorkspace();
  const p = await loadPolicy(ws);
  if (p.trusted.includes(pattern) || p.allow.includes(pattern)) return p;
  p.trusted.push(pattern);
  await savePolicy(p, ws);
  return p;
}

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

export interface DecisionDetail {
  decision: Decision;
  /** Pattern that matched, for display in the UI ("blocked by `rm -rf /*`"). */
  matched?: string;
  /** Suggested pattern to register with "Allow always" — the verb only. */
  suggestedAllow: string;
}

/**
 * Suggest a coarse "verb + first arg" glob from a free-form command, e.g.
 *   `git push --force origin main` → `git push *`
 *   `npm install lodash`           → `npm install *`
 *   `pytest -k foo`                → `pytest *`
 * This is what we offer the user as the "Allow always" pattern.
 */
function suggestAllowPattern(cmd: string): string {
  const stripped = cmd.trim().replace(/^[A-Z_]+=\S+\s+/g, ""); // drop leading "VAR=val "
  const parts = stripped.split(/\s+/);
  if (parts.length <= 1) return parts[0] || cmd.trim();
  // For two-word "verb sub" commands like `git push`, `npm install`, suggest `verb sub *`.
  const TWO_WORD_VERBS = new Set([
    "git", "npm", "pnpm", "yarn", "cargo", "go", "docker", "kubectl", "gh", "pip", "pip3", "brew",
  ]);
  if (TWO_WORD_VERBS.has(parts[0])) return `${parts[0]} ${parts[1]} *`;
  return `${parts[0]} *`;
}

export async function decide(cmd: string, workspace?: string): Promise<DecisionDetail> {
  const p = await loadPolicy(workspace);
  const denied = anyMatch(cmd, p.deny);
  if (denied) {
    return { decision: "deny", matched: denied, suggestedAllow: suggestAllowPattern(cmd) };
  }
  const allowed = anyMatch(cmd, p.allow) ?? anyMatch(cmd, p.trusted);
  if (allowed) {
    return { decision: "allow", matched: allowed, suggestedAllow: suggestAllowPattern(cmd) };
  }
  // YOLO escape hatch — only kicks in *after* the deny-list check above so
  // the dangerous patterns (rm -rf /, sudo, force-push, npm publish, …) are
  // still blocked. The trace will show `matched: "auto-approve"` so the user
  // can tell at a glance why something ran without a prompt.
  if (p.autoApprove) {
    return { decision: "allow", matched: "auto-approve", suggestedAllow: suggestAllowPattern(cmd) };
  }
  return { decision: "ask", suggestedAllow: suggestAllowPattern(cmd) };
}
