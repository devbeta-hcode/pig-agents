/**
 * Desktop service layer.
 *
 * Pure async functions that replace every Express route from the web app.
 * The Electron main process calls these directly over IPC — no HTTP, no SSE,
 * no WebSocket. Streaming (agent runs, sessions, command log, terminal, fs
 * watch) is handled separately by the main process using the callback-based
 * primitives exported from `index.ts`.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import crypto from "node:crypto";

import { listFiles, readFile, writeFile, createEntry, deleteEntry, copyEntry, searchCode } from "./tools/file.js";
import { runCommand } from "./tools/command.js";
import { BA_DIFF_CREATED_FROM_ABSENT } from "./tools/patch.js";
import { getWorkspace, setWorkspace, safeJoin } from "./utils/workspace.js";
import {
  createCheckpoint,
  deleteCheckpoint,
  listCheckpoints,
  restoreCheckpoint,
} from "./utils/checkpoints.js";
import {
  loadPolicy,
  savePolicy,
  setAutoApprove,
  setAutoApproveWeb,
  trust as policyTrust,
  type Policy,
} from "./utils/policy.js";
import { resolveApproval, type ApprovalDecision } from "./utils/approvals.js";
import { runGit, isRepo } from "./utils/git.js";
import {
  clearAgentCommands,
  deleteAgentCommand,
  getAgentCommand,
  listAgentCommands,
} from "./agent/commandLog.js";
import {
  startSession,
  getSession,
  listSessions,
  getRunningSessions,
  abortSession,
  deleteSession,
  getStats as getSessionStats,
} from "./agent/sessionManager.js";
import { LLM_INTEGRATIONS, resolveIntegrationBaseUrl } from "./llm/integrations.js";
import { normalizePromptMode } from "./llm/prompt-mode.js";
import {
  buildMergedProfiles,
  DEFAULT_PROFILES,
  ensureProfilesSeededFromEnv,
  mergeProfile,
  migrateLegacyEnvApiKeyIntoProfiles,
  normalizeLlmProviderId,
  profileApiKeySet,
  profilesFilePath,
  readProfilesFile,
  type ProfileSlot,
  writeProfilesFile,
} from "./llm/profiles.js";

// ===========================================================================
// Workspace + filesystem
// ===========================================================================

export function workspaceGet() {
  return { workspace: getWorkspace() };
}

export function workspaceSet(p: string) {
  if (!p) throw new Error("path required");
  return { workspace: setWorkspace(p) };
}

export async function listFilesSvc(dir = ".") {
  return { dir, items: await listFiles(dir) };
}

export async function readFileSvc(p: string) {
  if (!p) throw new Error("path required");
  return { path: p, content: await readFile(p) };
}

export async function writeFileSvc(p: string, content: string) {
  if (!p) throw new Error("path required");
  await writeFile(p, content ?? "");
  return { ok: true as const };
}

export async function createEntrySvc(p: string, kind: "file" | "dir") {
  if (!p) throw new Error("path required");
  await createEntry(p, kind === "dir" ? "dir" : "file");
  return { ok: true as const };
}

export async function copyEntrySvc(from: string, to: string) {
  if (!from || !to) throw new Error("from and to required");
  const finalPath = await copyEntry(from, to);
  return { ok: true as const, path: finalPath };
}

export async function deleteEntrySvc(p: string) {
  if (!p) throw new Error("path required");
  await deleteEntry(p);
  return { ok: true as const };
}

export async function searchSvc(query: string) {
  if (!query) throw new Error("query required");
  return { query, hits: await searchCode(query, 100) };
}

// ---- folder browser (native picker fallback / "Open Folder" dialog UI) ----

interface BrowseEntry {
  name: string;
  path: string;
  isDir: boolean;
}

export function fsHome() {
  const home = os.homedir();
  const roots: { label: string; path: string }[] = [{ label: "Home", path: home }];
  if (process.platform === "win32") {
    for (const drive of ["C:\\", "D:\\", "E:\\"]) {
      if (fs.existsSync(drive)) roots.push({ label: drive, path: drive });
    }
  } else {
    roots.push({ label: "Root", path: "/" });
  }
  for (const sub of ["projects", "code", "workspace", "Documents", "Desktop"]) {
    const p = path.join(home, sub);
    if (fs.existsSync(p)) roots.push({ label: sub, path: p });
  }
  return { home, roots };
}

export async function fsBrowse(target: string, showHidden = false) {
  const abs = path.resolve(target || os.homedir());
  const stat = await fsp.stat(abs);
  if (!stat.isDirectory()) throw new Error("Not a directory");
  const dirents = await fsp.readdir(abs, { withFileTypes: true });
  const entries: BrowseEntry[] = [];
  for (const d of dirents) {
    if (!showHidden && d.name.startsWith(".")) continue;
    let isDir = d.isDirectory();
    if (d.isSymbolicLink()) {
      try {
        isDir = (await fsp.stat(path.join(abs, d.name))).isDirectory();
      } catch {
        continue;
      }
    }
    entries.push({ name: d.name, path: path.join(abs, d.name), isDir });
  }
  entries.sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name)));
  const parent = path.dirname(abs);
  const crumbs: { label: string; path: string }[] = [];
  let cur = abs;
  while (true) {
    const parentDir = path.dirname(cur);
    crumbs.unshift({ label: path.basename(cur) || cur, path: cur });
    if (parentDir === cur) break;
    cur = parentDir;
  }
  return { path: abs, parent: parent === abs ? null : parent, entries, crumbs };
}

export async function renameSvc(from: string, to: string) {
  if (!from || !to) throw new Error("from and to required");
  const fromAbs = safeJoin(from);
  const toAbs = safeJoin(to);
  await fsp.mkdir(path.dirname(toAbs), { recursive: true });
  await fsp.rename(fromAbs, toAbs);
  return { ok: true as const };
}

export async function runCommandSvc(cmd: string) {
  if (!cmd) throw new Error("cmd required");
  return runCommand(cmd, { timeoutMs: 120_000 });
}

// ===========================================================================
// Checkpoints
// ===========================================================================

export async function checkpointsList() {
  return { workspace: getWorkspace(), checkpoints: await listCheckpoints() };
}

export async function checkpointCreate(label?: string) {
  const cp = await createCheckpoint(label || `Manual ${new Date().toLocaleTimeString()}`, { kind: "manual" });
  if (!cp) throw new Error("could not create checkpoint (git unavailable?)");
  return { ok: true as const, checkpoint: cp };
}

export async function checkpointRestore(id: string) {
  const r = await restoreCheckpoint(id);
  if (!r.ok) throw new Error((r as { error?: string }).error || "restore failed");
  return r;
}

export async function checkpointDelete(id: string) {
  const ok = await deleteCheckpoint(id);
  if (!ok) throw new Error("not found");
  return { ok: true as const };
}

// ===========================================================================
// Command policy
// ===========================================================================

export async function policyGet() {
  return { workspace: getWorkspace(), policy: await loadPolicy() };
}

export async function policySave(body: Partial<Policy>) {
  const next: Policy = {
    version: 1,
    deny: Array.isArray(body.deny) ? body.deny.map(String) : [],
    allow: Array.isArray(body.allow) ? body.allow.map(String) : [],
    trusted: Array.isArray(body.trusted) ? body.trusted.map(String) : [],
    autoApprove: !!body.autoApprove,
  };
  await savePolicy(next);
  return { ok: true as const, policy: next };
}

export async function policyAutoApprove(value: boolean) {
  const p = await setAutoApprove(!!value);
  return { ok: true as const, autoApprove: !!p.autoApprove, policy: p };
}

export async function policyAutoApproveWeb(value: boolean) {
  const p = await setAutoApproveWeb(!!value);
  return { ok: true as const, autoApproveWeb: !!p.autoApproveWeb, policy: p };
}

export async function policyTrustPattern(pattern: string) {
  const trimmed = String(pattern || "").trim();
  if (!trimmed) throw new Error("pattern required");
  return { ok: true as const, policy: await policyTrust(trimmed) };
}

export function approvalRespond(askId: string, decision: ApprovalDecision, editedCmd?: string) {
  if (!["allow_once", "allow_always", "deny"].includes(decision)) {
    throw new Error("decision must be allow_once | allow_always | deny");
  }
  const ok = resolveApproval(askId, { decision, editedCmd });
  if (!ok) throw new Error("no pending approval with that askId (timed out or already answered)");
  return { ok: true as const };
}

// ===========================================================================
// Agent command log
// ===========================================================================

export function agentCommandsList() {
  return { runs: listAgentCommands() };
}

export function agentCommandGet(id: string) {
  const r = getAgentCommand(id);
  if (!r) throw new Error("not found");
  return r;
}

export function agentCommandsClear() {
  return { ok: true as const, removed: clearAgentCommands() };
}

export function agentCommandDelete(id: string) {
  const ok = deleteAgentCommand(id);
  if (!ok) throw new Error("not found");
  return { ok: true as const, id };
}

// ===========================================================================
// Agent sessions
// ===========================================================================

export function sessionStart(
  task: string,
  mode: "ask" | "agent" = "agent",
  images?: { dataUrl: string; name: string }[],
) {
  if (!task) throw new Error("task required");
  const session = startSession(task, mode === "ask" ? "ask" : "agent", getWorkspace(), images);
  return { ok: true as const, session };
}

export function sessionList() {
  const workspace = getWorkspace();
  return { sessions: listSessions(workspace), stats: getSessionStats(), workspace };
}

export function sessionRunning() {
  const workspace = getWorkspace();
  return { running: getRunningSessions(workspace), workspace };
}

export function sessionAllRunning() {
  return { running: getRunningSessions(undefined) };
}

export function sessionGet(id: string) {
  const session = getSession(id);
  if (!session) throw new Error("session not found");
  return { session };
}

export function sessionAbort(id: string) {
  if (!abortSession(id)) throw new Error("session not found or not running");
  return { ok: true as const, id };
}

export function sessionDelete(id: string) {
  if (!deleteSession(id)) throw new Error("session not found or still running");
  return { ok: true as const, id };
}

// ===========================================================================
// Diff revert (ported from api/diff.ts)
// ===========================================================================

interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  body: string[];
}

function normalizeEOL(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function detectPreferredEOL(text: string): "\n" | "\r\n" {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

function applyEOL(text: string, eol: "\n" | "\r\n"): string {
  if (eol === "\n") return text;
  return text.split("\n").join("\r\n");
}

/** Keep trailing newline behaviour stable after splice (Windows CRLF vs LF). */
function preserveTrailingNewline(original: string, next: string): string {
  const orig = normalizeEOL(original);
  const hadTrailing = orig.endsWith("\n");
  let out = next;
  if (hadTrailing && !out.endsWith("\n")) out += "\n";
  if (!hadTrailing && out.endsWith("\n")) out = out.replace(/\n$/, "");
  return out;
}

function splitFileLines(text: string): string[] {
  const norm = normalizeEOL(text);
  if (norm.length === 0) return [];
  const parts = norm.split("\n");
  if (norm.endsWith("\n") && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

function joinFileLines(lines: string[]): string {
  return lines.join("\n");
}

function parseDiff(diff: string): { path: string; hunks: Hunk[] } | null {
  const headerMatch = /^---\s+a\/(.+)$/m.exec(diff);
  if (!headerMatch) return null;
  const p = headerMatch[1];
  const lines = diff.split("\n");
  const hunks: Hunk[] = [];
  let cur: Hunk | null = null;
  for (const ln of lines) {
    const hm = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(ln);
    if (hm) {
      if (cur) hunks.push(cur);
      cur = {
        oldStart: parseInt(hm[1], 10),
        oldLines: hm[2] ? parseInt(hm[2], 10) : 1,
        newStart: parseInt(hm[3], 10),
        newLines: hm[4] ? parseInt(hm[4], 10) : 1,
        body: [],
      };
      continue;
    }
    if (!cur) continue;
    if (ln.startsWith("--- ") || ln.startsWith("+++ ") || ln.startsWith("diff ")) continue;
    cur.body.push(ln);
  }
  if (cur) hunks.push(cur);
  return { path: p, hunks };
}

function hunkSlices(body: string[]): { before: string[]; after: string[] } {
  const before: string[] = [];
  const after: string[] = [];
  for (const ln of body) {
    if (ln.length === 0) continue;
    if (ln.startsWith("\\")) continue;
    const marker = ln[0];
    const text = ln.slice(1).replace(/\r$/, "");
    if (marker === " ") { before.push(text); after.push(text); }
    else if (marker === "-") before.push(text);
    else if (marker === "+") after.push(text);
  }
  return { before, after };
}

function isPureAdditionFromEmptyFile(diff: string): boolean {
  const lines = diff.split("\n");
  let inHunk = false;
  let sawPlus = false;
  for (const ln of lines) {
    if (ln.startsWith("@@ ")) { inHunk = true; continue; }
    if (!inHunk) continue;
    if (ln.startsWith("\\")) continue;
    if (ln.length === 0) continue;
    const c = ln[0];
    if (c === "+") { sawPlus = true; continue; }
    if (c === " " || c === "-") return false;
    return false;
  }
  return sawPlus;
}

function shouldDeleteFileWhenRevertedToEmpty(diff: string): boolean {
  if (diff.includes(BA_DIFF_CREATED_FROM_ABSENT)) return true;
  return isPureAdditionFromEmptyFile(diff);
}

function revertHunkInPlace(current: string, hunk: Hunk): { ok: boolean; mode: string; next?: string } {
  const preferredEOL = detectPreferredEOL(current);
  const { before, after } = hunkSlices(hunk.body);
  const afterBlock = joinFileLines(after);
  const beforeBlock = joinFileLines(before);
  const fileLines = splitFileLines(current);
  const start = Math.max(0, hunk.newStart - 1);
  const candidate = joinFileLines(fileLines.slice(start, start + hunk.newLines));
  if (candidate === afterBlock) {
    const nextNorm = joinFileLines([
      ...fileLines.slice(0, start),
      ...before,
      ...fileLines.slice(start + hunk.newLines),
    ]);
    const next = applyEOL(preserveTrailingNewline(current, nextNorm), preferredEOL);
    return { ok: true, mode: "strict", next };
  }
  const normCurrent = normalizeEOL(current);
  if (afterBlock && normCurrent.includes(afterBlock)) {
    const occurrences = normCurrent.split(afterBlock).length - 1;
    if (occurrences === 1) {
      const nextNorm = preserveTrailingNewline(current, normCurrent.replace(afterBlock, beforeBlock));
      const next = applyEOL(nextNorm, preferredEOL);
      return { ok: true, mode: "substring", next };
    }
  }
  return { ok: false, mode: "miss" };
}

export async function diffRevert(diff: string) {
  if (!diff) throw new Error("diff required");
  const parsed = parseDiff(diff);
  if (!parsed) throw new Error("invalid diff (no --- a/ header)");
  if (parsed.hunks.length === 0) throw new Error("invalid diff (no @@ marker)");
  let current: string;
  try {
    current = await readFile(parsed.path);
  } catch {
    if (shouldDeleteFileWhenRevertedToEmpty(diff)) {
      return { ok: true as const, mode: "noop", path: parsed.path, deleted: true, alreadyAbsent: true };
    }
    throw new Error(`file not found: ${parsed.path}`);
  }
  const modes: string[] = [];
  for (const h of [...parsed.hunks].reverse()) {
    const r = revertHunkInPlace(current, h);
    if (!r.ok) throw new Error("current file does not match diff; revert skipped");
    current = r.next!;
    modes.push(r.mode);
  }
  if (current === "" && shouldDeleteFileWhenRevertedToEmpty(diff)) {
    await deleteEntry(parsed.path);
    return { ok: true as const, mode: modes.join("+"), path: parsed.path, deleted: true };
  }
  await writeFile(parsed.path, current);
  return { ok: true as const, mode: modes.join("+"), path: parsed.path };
}

export async function diffRevertHunk(diff: string, hunkIndex: number) {
  if (!diff) throw new Error("diff required");
  if (!Number.isInteger(hunkIndex) || hunkIndex < 0) throw new Error("hunkIndex must be a non-negative integer");
  const parsed = parseDiff(diff);
  if (!parsed) throw new Error("invalid diff (no --- a/ header)");
  if (hunkIndex >= parsed.hunks.length) throw new Error(`hunkIndex out of range (have ${parsed.hunks.length})`);
  let current: string;
  try {
    current = await readFile(parsed.path);
  } catch {
    if (shouldDeleteFileWhenRevertedToEmpty(diff)) {
      return { ok: true as const, mode: "noop", path: parsed.path, hunkIndex, deleted: true, alreadyAbsent: true };
    }
    throw new Error(`file not found: ${parsed.path}`);
  }
  const r = revertHunkInPlace(current, parsed.hunks[hunkIndex]);
  if (!r.ok) throw new Error("current file does not match this hunk; revert skipped");
  const nextContent = r.next!;
  if (nextContent === "" && shouldDeleteFileWhenRevertedToEmpty(diff)) {
    await deleteEntry(parsed.path);
    return { ok: true as const, mode: r.mode, path: parsed.path, hunkIndex, deleted: true };
  }
  await writeFile(parsed.path, nextContent);
  return { ok: true as const, mode: r.mode, path: parsed.path, hunkIndex };
}

// ===========================================================================
// Settings (ported from api/settings.ts)
// ===========================================================================

const SAFE_KEYS = ["LLM_PROVIDER", "BASE_URL", "MODEL", "MAX_CONTEXT_FILES", "MAX_ITERATIONS", "PROMPT_MODE", "LLM_MAX_TOKENS"];

function envFilePath(): string {
  if (process.env.PIG_ENV_FILE) return process.env.PIG_ENV_FILE;
  return path.join(os.homedir(), ".pig-agents", ".env");
}

async function readEnvFile(): Promise<Record<string, string>> {
  const p = envFilePath();
  const out: Record<string, string> = {};
  try {
    const txt = await fsp.readFile(p, "utf8");
    for (const line of txt.split(/\r?\n/)) {
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq < 0) continue;
      out[line.slice(0, eq).trim()] = line.slice(eq + 1);
    }
  } catch { /* file may not exist */ }
  return out;
}

async function writeEnvFile(updates: Record<string, string | undefined>) {
  const p = envFilePath();
  const cur = await readEnvFile();
  for (const [k, v] of Object.entries(updates)) {
    if (v === undefined) delete cur[k];
    else cur[k] = v;
  }
  const order = ["LLM_PROVIDER", "OPENAI_API_KEY", "BASE_URL", "MODEL", "MAX_CONTEXT_FILES", "MAX_ITERATIONS", "PROMPT_MODE", "LLM_MAX_TOKENS", "WORKSPACE_ROOT", "ALLOWED_WORKSPACE_ROOT"];
  const lines: string[] = [];
  for (const k of order) if (k in cur) lines.push(`${k}=${cur[k]}`);
  for (const k of Object.keys(cur)) if (!order.includes(k)) lines.push(`${k}=${cur[k]}`);
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.writeFile(p, lines.join("\n") + "\n", "utf8");
}

export function settingsGet() {
  let data = readProfilesFile();
  data = ensureProfilesSeededFromEnv(data);
  data = migrateLegacyEnvApiKeyIntoProfiles(data);
  const pid = normalizeLlmProviderId(process.env.LLM_PROVIDER);
  const slot = mergeProfile(pid, data);
  const merged = buildMergedProfiles(data);
  return {
    LLM_PROVIDER: pid,
    BASE_URL: slot.baseUrl,
    MODEL: slot.model,
    PROFILES: merged,
    MAX_CONTEXT_FILES: Number(process.env.MAX_CONTEXT_FILES || 5),
    MAX_ITERATIONS: Number(process.env.MAX_ITERATIONS || 50),
    PROMPT_MODE: normalizePromptMode(process.env.PROMPT_MODE || "balanced"),
    LLM_MAX_TOKENS: (() => {
      const raw = process.env.LLM_MAX_TOKENS;
      if (raw === undefined || raw === "") return 0;
      const n = Number(raw);
      return Number.isFinite(n) && n >= 64 ? Math.min(131072, Math.floor(n)) : 0;
    })(),
    OPENAI_API_KEY_SET: profileApiKeySet(pid, data),
    ENV_FILE: envFilePath(),
    PROFILES_FILE: profilesFilePath(),
    INTEGRATIONS: LLM_INTEGRATIONS,
  };
}

export async function settingsSave(body: Record<string, unknown>) {
  body = body || {};
  let data = readProfilesFile();
  data = ensureProfilesSeededFromEnv(data);
  data = migrateLegacyEnvApiKeyIntoProfiles(data);

  const prevPid = normalizeLlmProviderId(process.env.LLM_PROVIDER);
  const pid =
    body.LLM_PROVIDER !== undefined && body.LLM_PROVIDER !== null
      ? normalizeLlmProviderId(String(body.LLM_PROVIDER))
      : prevPid;

  const onlyProviderSwitch =
    body.LLM_PROVIDER !== undefined && body.BASE_URL === undefined && body.MODEL === undefined && body.OPENAI_API_KEY === undefined;

  const def = DEFAULT_PROFILES[pid];
  const prev: Partial<ProfileSlot> = data.profiles[pid] ?? {};
  let nextBase = prev.baseUrl ?? def.baseUrl;
  let nextModel = prev.model ?? def.model;
  let nextApiKey = prev.apiKey;

  if (!onlyProviderSwitch) {
    if (body.BASE_URL !== undefined) nextBase = String(body.BASE_URL);
    if (body.MODEL !== undefined) nextModel = String(body.MODEL);
  }
  if (body.OPENAI_API_KEY !== undefined) {
    const v = String(body.OPENAI_API_KEY);
    nextApiKey = v.length > 0 ? v : undefined;
  }

  const slot: ProfileSlot = { baseUrl: nextBase, model: nextModel };
  if (nextApiKey && nextApiKey.length > 0) slot.apiKey = nextApiKey;
  data.profiles[pid] = slot;
  writeProfilesFile(data);

  const merged = mergeProfile(pid, data);
  process.env.LLM_PROVIDER = pid;
  process.env.BASE_URL = merged.baseUrl;
  process.env.MODEL = merged.model;
  if (slot.apiKey && slot.apiKey.length > 0) process.env.OPENAI_API_KEY = slot.apiKey;
  else delete process.env.OPENAI_API_KEY;

  const persisted: Record<string, string | undefined> = {
    LLM_PROVIDER: pid,
    BASE_URL: merged.baseUrl,
    MODEL: merged.model,
    OPENAI_API_KEY: undefined,
  };
  for (const key of SAFE_KEYS) {
    if (key === "LLM_PROVIDER" || key === "BASE_URL" || key === "MODEL") continue;
    if (key in body && body[key] !== undefined && body[key] !== null) {
      if (key === "LLM_MAX_TOKENS") {
        const n = Number(body[key]);
        if (!Number.isFinite(n) || n <= 0) {
          delete process.env.LLM_MAX_TOKENS;
          persisted.LLM_MAX_TOKENS = undefined;
        } else {
          const str = String(Math.min(131072, Math.max(64, Math.floor(n))));
          process.env.LLM_MAX_TOKENS = str;
          persisted.LLM_MAX_TOKENS = str;
        }
        continue;
      }
      let value = String(body[key]);
      if (key === "PROMPT_MODE") value = normalizePromptMode(value);
      process.env[key] = value;
      persisted[key] = value;
    }
  }
  await writeEnvFile(persisted);
  return { ok: true as const, saved: true, envFile: envFilePath(), profilesFile: profilesFilePath() };
}

export async function ollamaModels(base?: string) {
  let b = String(base || process.env.BASE_URL || "http://localhost:11434").trim();
  b = b.replace(/\/$/, "").replace(/\/v1$/, "");
  const listUrl = b + "/api/tags";
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 2500);
    const r = await fetch(listUrl, { signal: ctl.signal });
    clearTimeout(t);
    if (!r.ok) return { ok: false as const, error: `Ollama responded ${r.status}` };
    const data = (await r.json()) as { models?: { name: string }[] };
    return { ok: true as const, base: b, models: (data.models || []).map((m) => m.name).filter(Boolean) };
  } catch (err) {
    return { ok: false as const, error: (err as Error).message, base: b };
  }
}

function openAiCompatibleModelsListUrl(rawBase: string): string {
  let b = rawBase.trim().replace(/\/$/, "");
  if (!b) b = "http://localhost:11434/v1";
  else if (/\/openai$/i.test(b)) return `${b}/models`;
  else if (!/\/v1$/i.test(b)) b = `${b}/v1`;
  return `${b}/models`;
}

function authHeadersForModelsList(listUrl: string): Record<string, string> {
  const key = process.env.OPENAI_API_KEY;
  if (/anthropic\.com/i.test(listUrl)) {
    if (!key) return {};
    return { "x-api-key": key, "anthropic-version": process.env.ANTHROPIC_API_VERSION?.trim() || "2023-06-01" };
  }
  const strictCloud = /openai\.com|googleapis\.com|openrouter\.ai|api\.groq\.com/i.test(listUrl);
  if (strictCloud) {
    if (!key) return {};
    return { Authorization: `Bearer ${key}` };
  }
  return { Authorization: `Bearer ${key || "local"}` };
}

export async function openaiCompatibleModels(base?: string) {
  let raw = String(base ?? process.env.BASE_URL ?? "").trim();
  if (!raw) {
    const prov = normalizeLlmProviderId(process.env.LLM_PROVIDER);
    raw = resolveIntegrationBaseUrl(prov, "");
  }
  const listUrl = openAiCompatibleModelsListUrl(raw);
  const headers = authHeadersForModelsList(listUrl);
  const needsCloudKey = /openai\.com|googleapis\.com|openrouter\.ai|anthropic\.com|api\.groq\.com/i.test(listUrl);
  if (needsCloudKey && Object.keys(headers).length === 0) {
    return { ok: false as const, error: "OPENAI_API_KEY not set", base: listUrl };
  }
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 8000);
    const r = await fetch(listUrl, { signal: ctl.signal, headers });
    clearTimeout(t);
    if (!r.ok) return { ok: false as const, error: `HTTP ${r.status}`, base: listUrl };
    const data = (await r.json()) as { data?: { id?: string }[] };
    const models = (data.data || []).map((m) => m.id).filter(Boolean) as string[];
    models.sort((a, b) => a.localeCompare(b));
    return { ok: true as const, base: listUrl.replace(/\/models$/, ""), models };
  } catch (err) {
    return { ok: false as const, error: (err as Error).message, base: listUrl };
  }
}

// ===========================================================================
// Git (ported from api/git.ts)
// ===========================================================================

interface GitFileEntry {
  path: string;
  origPath: string | null;
  code: string;
  indexStatus: string;
  workStatus: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
}

function parsePorcelainZ(out: string): GitFileEntry[] {
  const entries: GitFileEntry[] = [];
  if (!out) return entries;
  const tokens = out.split("\0");
  if (tokens.length && tokens[tokens.length - 1] === "") tokens.pop();
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.length < 3) continue;
    const code = t.slice(0, 2);
    const rest = t.slice(3);
    const indexStatus = code[0];
    const workStatus = code[1];
    let orig: string | null = null;
    if (indexStatus === "R" || indexStatus === "C" || workStatus === "R" || workStatus === "C") {
      orig = tokens[i + 1] ?? null;
      i += 1;
    }
    const untracked = code === "??";
    entries.push({
      path: rest,
      origPath: orig,
      code,
      indexStatus,
      workStatus,
      staged: !untracked && indexStatus !== " " && indexStatus !== "?",
      unstaged: untracked || (workStatus !== " " && workStatus !== "?"),
      untracked,
    });
  }
  return entries;
}

export async function gitStatus() {
  if (!(await isRepo())) return { ok: false as const, reason: "not_a_repo", workspace: getWorkspace() };
  const sb = await runGit(["status", "--porcelain=v1", "-z", "--branch", "--untracked-files=all"]);
  if (sb.exitCode !== 0) throw new Error(sb.stderr.trim() || "git status failed");
  let branchLine = "";
  let body = sb.stdout;
  const firstNul = body.indexOf("\0");
  if (firstNul >= 0 && body.startsWith("##")) {
    branchLine = body.slice(0, firstNul);
    body = body.slice(firstNul + 1);
  } else {
    const nl = body.indexOf("\n");
    if (nl >= 0 && body.startsWith("##")) {
      branchLine = body.slice(0, nl);
      body = body.slice(nl + 1);
    }
  }
  const files = parsePorcelainZ(body);
  let branch = "";
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  let detached = false;
  if (branchLine) {
    const tail = branchLine.slice(2).trim();
    if (tail.startsWith("No commits yet on ")) {
      branch = tail.slice("No commits yet on ".length).trim();
    } else if (tail.startsWith("HEAD (no branch)")) {
      branch = "HEAD";
      detached = true;
    } else {
      const m = /^([^.]+?)(?:\.\.\.([^\s]+))?(?:\s+\[(.+)\])?$/.exec(tail);
      if (m) {
        branch = m[1];
        upstream = m[2] ?? null;
        if (m[3]) {
          const aheadM = /ahead (\d+)/.exec(m[3]);
          const behindM = /behind (\d+)/.exec(m[3]);
          if (aheadM) ahead = parseInt(aheadM[1], 10);
          if (behindM) behind = parseInt(behindM[1], 10);
        }
      }
    }
  }
  return { ok: true as const, workspace: getWorkspace(), branch, upstream, ahead, behind, detached, files };
}

export async function gitDiff(p: string, opts?: { staged?: boolean; untracked?: boolean }) {
  if (!(await isRepo())) throw new Error("Not a git repository");
  if (!p) throw new Error("path required");
  const staged = !!opts?.staged;
  const untracked = !!opts?.untracked;
  if (untracked) {
    const r = await runGit(["diff", "--no-color", "--no-index", "--", "/dev/null", p]);
    if (r.exitCode < 0) throw new Error(r.stderr.trim() || "git diff failed");
    return { path: p, staged: false, untracked: true, diff: r.stdout };
  }
  const args = ["diff", "--no-color"];
  if (staged) args.push("--cached");
  args.push("--", p);
  const r = await runGit(args);
  if (r.exitCode !== 0 && r.exitCode !== 1) throw new Error(r.stderr.trim() || "git diff failed");
  return { path: p, staged, untracked: false, diff: r.stdout };
}

function cleanPaths(paths: unknown): string[] {
  if (!Array.isArray(paths)) return [];
  return paths.filter((p): p is string => typeof p === "string" && p.length > 0);
}

export async function gitStage(paths: string[]) {
  if (!(await isRepo())) throw new Error("Not a git repository");
  const ps = cleanPaths(paths);
  if (ps.length === 0) throw new Error("paths required");
  const r = await runGit(["add", "--", ...ps]);
  if (r.exitCode !== 0) throw new Error(r.stderr.trim() || "git add failed");
  return { ok: true as const };
}

export async function gitUnstage(paths: string[]) {
  if (!(await isRepo())) throw new Error("Not a git repository");
  const ps = cleanPaths(paths);
  if (ps.length === 0) throw new Error("paths required");
  const r = await runGit(["restore", "--staged", "--", ...ps]);
  if (r.exitCode !== 0) {
    const fb = await runGit(["reset", "HEAD", "--", ...ps]);
    if (fb.exitCode !== 0) throw new Error(fb.stderr.trim() || r.stderr.trim() || "unstage failed");
  }
  return { ok: true as const };
}

export async function gitDiscard(paths: string[]) {
  if (!(await isRepo())) throw new Error("Not a git repository");
  const ps = cleanPaths(paths);
  if (ps.length === 0) throw new Error("paths required");
  const r = await runGit(["checkout", "--", ...ps]);
  if (r.exitCode !== 0) throw new Error(r.stderr.trim() || "discard failed");
  return { ok: true as const };
}

export async function gitCommit(message: string, opts?: { stageAll?: boolean; signoff?: boolean }) {
  if (!(await isRepo())) throw new Error("Not a git repository");
  const msg = typeof message === "string" ? message.trim() : "";
  if (!msg) throw new Error("message required");
  if (opts?.stageAll) {
    const add = await runGit(["add", "-A"]);
    if (add.exitCode !== 0) throw new Error(add.stderr.trim() || "git add -A failed");
  }
  const args = ["commit", "-m", msg];
  if (opts?.signoff) args.push("--signoff");
  const r = await runGit(args);
  if (r.exitCode !== 0) throw new Error(r.stderr.trim() || r.stdout.trim() || "commit failed");
  return { ok: true as const, output: r.stdout };
}

interface GitLogEntry {
  hash: string;
  abbrev: string;
  parents: string[];
  author: string;
  email: string;
  date: string;
  ts: number;
  subject: string;
}

export async function gitLog(limit = 50) {
  if (!(await isRepo())) return { ok: false as const, reason: "not_a_repo", entries: [] as GitLogEntry[] };
  const lim = Math.max(1, Math.min(500, Number(limit) || 50));
  const FMT = ["%H", "%h", "%P", "%an", "%ae", "%aI", "%at", "%s"].join("%x1f") + "%x00";
  const r = await runGit(["log", `--max-count=${lim}`, `--pretty=format:${FMT}`]);
  if (r.exitCode !== 0) {
    if (/does not have any commits yet|bad default revision/i.test(r.stderr)) return { ok: true as const, entries: [] };
    throw new Error(r.stderr.trim() || "git log failed");
  }
  const records = r.stdout.split("\0").map((x) => x.replace(/^[\r\n]+/, "")).filter((x) => x.length > 0);
  const entries: GitLogEntry[] = records.map((rec) => {
    const [hash, abbrev, parents, author, email, date, ts, ...rest] = rec.split("\x1f");
    return {
      hash,
      abbrev,
      parents: parents ? parents.split(" ").filter(Boolean) : [],
      author,
      email,
      date,
      ts: parseInt(ts, 10) || 0,
      subject: rest.join("\x1f"),
    };
  });
  return { ok: true as const, entries };
}

export async function gitApply(patch: string, mode: "stage" | "discard" | "unstage") {
  if (!(await isRepo())) throw new Error("Not a git repository");
  if (!patch || !patch.trim()) throw new Error("patch required");
  const args = ["apply", "--whitespace=nowarn", "--unidiff-zero"];
  if (mode === "stage") args.push("--cached");
  else if (mode === "discard") args.push("--reverse");
  else if (mode === "unstage") args.push("--cached", "--reverse");
  else throw new Error("mode must be stage | discard | unstage");
  const input = patch.endsWith("\n") ? patch : patch + "\n";
  const r = await runGit(args, { input });
  if (r.exitCode !== 0) throw new Error(r.stderr.trim() || r.stdout.trim() || "git apply failed");
  return { ok: true as const };
}

export async function gitInit() {
  if (await isRepo()) return { ok: true as const, alreadyRepo: true };
  const r = await runGit(["init"]);
  if (r.exitCode !== 0) throw new Error(r.stderr.trim() || "git init failed");
  return { ok: true as const, output: r.stdout };
}

// ===========================================================================
// Chat history (ported from api/chats.ts)
// ===========================================================================

interface ChatTurn {
  id: string;
  task: string;
  mode?: "ask" | "agent";
  events: unknown[];
  status: "idle" | "running" | "done" | "error" | "stopped";
  startedAt: number;
  endedAt?: number;
}

interface ChatSession {
  id: string;
  title: string;
  workspace: string;
  mode?: "ask" | "agent";
  createdAt: number;
  updatedAt: number;
  turns: ChatTurn[];
  pendingDiffs?: unknown[];
}

interface SessionMeta {
  id: string;
  title: string;
  workspace: string;
  mode?: "ask" | "agent";
  createdAt: number;
  updatedAt: number;
  turnCount: number;
}

function chatsRootDir(): string {
  return path.join(os.homedir(), ".pig-agents", "chats");
}

function workspaceHash(ws: string): string {
  return crypto.createHash("sha1").update(path.resolve(ws)).digest("hex").slice(0, 16);
}

function chatsWorkspaceDir(ws: string): string {
  return path.join(chatsRootDir(), workspaceHash(ws));
}

async function chatsEnsureDir(p: string) {
  await fsp.mkdir(p, { recursive: true });
}

async function chatsSafeReadJSON<T>(p: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fsp.readFile(p, "utf8")) as T;
  } catch {
    return fallback;
  }
}

async function chatsAtomicWrite(p: string, data: string) {
  await chatsEnsureDir(path.dirname(p));
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  await fsp.writeFile(tmp, data, "utf8");
  await fsp.rename(tmp, p);
}

function isValidId(id: string): boolean {
  return typeof id === "string" && /^[A-Za-z0-9_\-]+$/.test(id) && id.length > 0 && id.length < 80;
}

function chatsIndexPath(ws: string): string {
  return path.join(chatsWorkspaceDir(ws), "index.json");
}

function chatsSessionPath(ws: string, id: string): string {
  if (!isValidId(id)) throw new Error("invalid session id");
  return path.join(chatsWorkspaceDir(ws), `${id}.json`);
}

function readIndex(ws: string): Promise<SessionMeta[]> {
  return chatsSafeReadJSON<SessionMeta[]>(chatsIndexPath(ws), []);
}

async function writeIndex(ws: string, list: SessionMeta[]) {
  await chatsAtomicWrite(chatsIndexPath(ws), JSON.stringify(list, null, 2));
}

function metaFromSession(s: ChatSession): SessionMeta {
  return {
    id: s.id,
    title: s.title,
    workspace: s.workspace,
    mode: s.mode,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    turnCount: Array.isArray(s.turns) ? s.turns.length : 0,
  };
}

function requireWs(ws: string): string {
  if (!ws || typeof ws !== "string" || ws.trim().length === 0) throw new Error("workspace param required");
  return ws;
}

export async function chatsList(ws: string) {
  requireWs(ws);
  const list = (await readIndex(ws)).sort((a, b) => b.updatedAt - a.updatedAt);
  return { workspace: ws, sessions: list };
}

export async function chatGet(ws: string, id: string) {
  requireWs(ws);
  if (!isValidId(id)) throw new Error("invalid id");
  try {
    return JSON.parse(await fsp.readFile(chatsSessionPath(ws, id), "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new Error("not found");
    throw err;
  }
}

export async function chatPut(ws: string, body: Partial<ChatSession> & { id: string }) {
  requireWs(ws);
  const id = body.id;
  if (!isValidId(id)) throw new Error("invalid id");
  const session: ChatSession = {
    id,
    title: String(body.title ?? "New chat"),
    workspace: ws,
    mode: body.mode,
    createdAt: Number(body.createdAt ?? Date.now()),
    updatedAt: Number(body.updatedAt ?? Date.now()),
    turns: Array.isArray(body.turns) ? (body.turns as ChatTurn[]) : [],
    pendingDiffs: Array.isArray(body.pendingDiffs) ? body.pendingDiffs : [],
  };
  await chatsAtomicWrite(chatsSessionPath(ws, id), JSON.stringify(session));
  const idx = await readIndex(ws);
  const meta = metaFromSession(session);
  const i = idx.findIndex((m) => m.id === id);
  if (i >= 0) idx[i] = meta;
  else idx.push(meta);
  await writeIndex(ws, idx);
  return { ok: true as const, meta };
}

export async function chatPatch(ws: string, id: string, patch: Partial<ChatSession>) {
  requireWs(ws);
  if (!isValidId(id)) throw new Error("invalid id");
  const sp = chatsSessionPath(ws, id);
  let cur: ChatSession;
  try {
    cur = JSON.parse(await fsp.readFile(sp, "utf8")) as ChatSession;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new Error("not found");
    throw err;
  }
  const next: ChatSession = {
    ...cur,
    title: typeof patch.title === "string" ? patch.title : cur.title,
    mode: patch.mode ?? cur.mode,
    updatedAt: Date.now(),
  };
  await chatsAtomicWrite(sp, JSON.stringify(next));
  const idx = await readIndex(ws);
  const i = idx.findIndex((m) => m.id === id);
  if (i >= 0) {
    idx[i] = metaFromSession(next);
    await writeIndex(ws, idx);
  }
  return { ok: true as const, meta: metaFromSession(next) };
}

export async function chatDelete(ws: string, id: string) {
  requireWs(ws);
  if (!isValidId(id)) throw new Error("invalid id");
  const sp = chatsSessionPath(ws, id);
  try { await fsp.unlink(sp); } catch { /* may not exist */ }
  const idx = (await readIndex(ws)).filter((m) => m.id !== id);
  await writeIndex(ws, idx);
  return { ok: true as const };
}

export async function chatsSearch(ws: string, q: string, limit = 50) {
  requireWs(ws);
  const query = String(q || "").trim();
  if (query.length === 0) return { workspace: ws, query, hits: [] };
  const lim = Math.min(Number(limit) || 50, 200);
  const dir = chatsWorkspaceDir(ws);
  try { await fsp.access(dir); } catch { return { workspace: ws, query, hits: [] }; }
  const idx = await readIndex(ws);
  const ql = query.toLowerCase();
  type Hit = { id: string; title: string; updatedAt: number; snippet: string; matches: number };
  const hits: Hit[] = [];
  const snippetFrom = (text: string): string => {
    const at = text.toLowerCase().indexOf(ql);
    if (at < 0) return "";
    const start = Math.max(0, at - 60);
    const end = Math.min(text.length, at + ql.length + 60);
    return (start > 0 ? "…" : "") + text.slice(start, end).replace(/\s+/g, " ").trim() + (end < text.length ? "…" : "");
  };
  for (const meta of idx) {
    if (hits.length >= lim) break;
    const titleMatch = meta.title.toLowerCase().includes(ql);
    let raw = "";
    try { raw = await fsp.readFile(path.join(dir, `${meta.id}.json`), "utf8"); } catch { continue; }
    if (!titleMatch && !raw.toLowerCase().includes(ql)) continue;
    let snippet = "";
    let matches = 0;
    try {
      const sess = JSON.parse(raw) as ChatSession;
      const buckets: string[] = [];
      for (const t of Array.isArray(sess.turns) ? sess.turns : []) {
        const turn = t as unknown as Record<string, unknown>;
        if (typeof turn.task === "string") buckets.push(turn.task);
        if (typeof turn.final === "string") buckets.push(turn.final as string);
        const events = (t as { events?: unknown }).events;
        if (Array.isArray(events)) {
          for (const ev of events) {
            const o = ev as Record<string, unknown>;
            for (const k of ["text", "message", "content", "output"]) {
              const v = o[k];
              if (typeof v === "string") buckets.push(v);
            }
          }
        }
      }
      for (const b of buckets) {
        const lo = b.toLowerCase();
        let scan = lo.indexOf(ql);
        while (scan >= 0) { matches++; if (matches >= 50) break; scan = lo.indexOf(ql, scan + ql.length); }
        if (!snippet) { const s = snippetFrom(b); if (s) snippet = s; }
      }
      if (!snippet && titleMatch) snippet = sess.title;
    } catch { /* fall through */ }
    if (!snippet) {
      snippet = snippetFrom(raw) || meta.title;
      if (matches === 0) matches = 1;
    }
    hits.push({ id: meta.id, title: meta.title, updatedAt: meta.updatedAt, snippet, matches: matches || 1 });
  }
  hits.sort((a, b) => b.matches - a.matches || b.updatedAt - a.updatedAt);
  return { workspace: ws, query, hits };
}

export async function chatsExport(ws: string) {
  requireWs(ws);
  const idx = await readIndex(ws);
  const sessions: ChatSession[] = [];
  for (const meta of idx) {
    try { sessions.push(JSON.parse(await fsp.readFile(chatsSessionPath(ws, meta.id), "utf8"))); } catch { /* skip */ }
  }
  return { kind: "pig-agents.chats.v1", workspace: ws, exportedAt: Date.now(), sessions };
}

export async function chatsImport(ws: string, sessionsIn: unknown[]) {
  requireWs(ws);
  const incoming = (Array.isArray(sessionsIn) ? sessionsIn : []) as ChatSession[];
  const idx = await readIndex(ws);
  const existing = new Set(idx.map((m) => m.id));
  let imported = 0;
  for (const s of incoming) {
    if (!s || typeof s !== "object" || typeof s.title !== "string") continue;
    let id = typeof s.id === "string" && isValidId(s.id) ? s.id : "";
    if (!id || existing.has(id)) id = `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const session: ChatSession = {
      id,
      title: s.title,
      workspace: ws,
      mode: s.mode,
      createdAt: Number(s.createdAt) || Date.now(),
      updatedAt: Number(s.updatedAt) || Date.now(),
      turns: Array.isArray(s.turns) ? s.turns : [],
      pendingDiffs: Array.isArray((s as { pendingDiffs?: unknown }).pendingDiffs) ? (s as { pendingDiffs: unknown[] }).pendingDiffs : [],
    };
    try {
      await chatsAtomicWrite(chatsSessionPath(ws, id), JSON.stringify(session));
      existing.add(id);
      const meta = metaFromSession(session);
      const i = idx.findIndex((m) => m.id === id);
      if (i >= 0) idx[i] = meta;
      else idx.push(meta);
      imported++;
    } catch { /* skip */ }
  }
  await writeIndex(ws, idx);
  return { ok: true as const, imported, total: incoming.length };
}

void url;
