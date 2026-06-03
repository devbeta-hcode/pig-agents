import path from "node:path";
import fs from "node:fs/promises";
import { safeJoin, toRel } from "../utils/workspace.js";
import { buildMatchCentricPreview } from "./smartPreview.js";
import { projectPathBoost, defaultEntryPaths } from "./projectAnchors.js";
import { activeUserTaskSlice } from "../llm/prompt-compact.js";
import { looksLikeDebugTask, pathsMentionedInTask } from "../agent/taskShape.js";
import { semanticPathScores } from "../index/embeddingIndex.js";

const IGNORED = new Set([
  "node_modules", ".git", "dist", "build", ".next", ".turbo", ".cache", ".venv", "__pycache__",
]);

const TEXT_EXT = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".rb", ".go", ".rs", ".java", ".kt", ".swift",
  ".c", ".h", ".cc", ".cpp", ".hpp", ".cs",
  ".json", ".yml", ".yaml", ".toml", ".md", ".txt", ".html", ".css", ".scss",
  ".sh", ".bash", ".zsh",
]);

export interface ScoredFile {
  path: string;
  score: number;
  preview: string;
}

function tokenize(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9_]+/).filter((t) => t.length > 1);
}

async function walkPaths(rel: string): Promise<string[]> {
  const out: string[] = [];
  const root = safeJoin(rel);
  const scanLimit = Math.max(200, Number(process.env.MAX_CONTEXT_SCAN_FILES || 800));
  let scanned = 0;
  async function walk(dir: string) {
    if (scanned >= scanLimit) return;
    let dirents: import("node:fs").Dirent[];
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of dirents) {
      if (scanned >= scanLimit) return;
      if (IGNORED.has(d.name)) continue;
      const full = path.join(dir, d.name);
      if (d.isDirectory()) {
        await walk(full);
      } else if (d.isFile()) {
        scanned++;
        const ext = path.extname(d.name).toLowerCase();
        if (TEXT_EXT.has(ext)) out.push(full);
      }
    }
  }
  await walk(root);
  return out;
}

function pathOnlyScore(rel: string, tokens: string[], explicitPaths: string[], semantic: Map<string, number>): number {
  let score = projectPathBoost(rel) + (semantic.get(rel.replace(/\\/g, "/")) ?? 0);
  const lowerRel = rel.toLowerCase();
  for (const ep of explicitPaths) {
    if (lowerRel === ep || lowerRel.endsWith("/" + ep) || ep.endsWith(lowerRel)) score += 200;
  }
  for (const tok of tokens) {
    if (lowerRel.includes(tok)) score += 5;
    const baseName = path.basename(lowerRel, path.extname(lowerRel));
    if (baseName === tok) score += 8;
  }
  return score;
}

async function semanticBoostForTask(task: string): Promise<Map<string, number>> {
  if (process.env.LLM_DISABLE_SEMANTIC_INDEX === "1" || process.env.LLM_DISABLE_SEMANTIC_INDEX === "true") {
    return new Map();
  }
  const slice = activeUserTaskSlice(task).trim().slice(0, 400);
  if (slice.length < 4) return new Map();
  try {
    return await semanticPathScores(slice, 6);
  } catch {
    return new Map();
  }
}

const STATIC_WEB_ROOT_FILES = [
  "index.html",
  "index.htm",
  "style.css",
  "styles.css",
  "script.js",
  "main.js",
  "app.js",
] as const;

function taskWantsSourceFileContext(task: string): boolean {
  if (pathsMentionedInTask(task).some((p) => /\.(html?|css|js|tsx?|jsx?|mjs|cjs)$/i.test(p))) return true;
  const t = activeUserTaskSlice(task).toLowerCase();
  return /\b(react|jsx|tsx|html|css|javascript|js|chuyển|chuyen|convert|migrate|port|frontend|trang web|vanilla|component|rewrite|đọc file|doc file)\b/i.test(
    t,
  );
}

async function scoredFileFromPath(
  rel: string,
  score: number,
  tokens: string[],
  preferDebugLines = false,
): Promise<ScoredFile | null> {
  const norm = rel.replace(/\\/g, "/").replace(/^\.\//, "");
  let abs: string;
  try {
    abs = safeJoin(norm);
  } catch {
    return null;
  }
  try {
    const stat = await fs.stat(abs);
    if (!stat.isFile() || stat.size > 512 * 1024) return null;
    const content = await fs.readFile(abs, "utf8");
    const tight = process.env.LLM_CONTEXT_BUDGET === "tight";
    const previewMax = tight ? 480 : 720;
    return {
      path: norm,
      score,
      preview: buildMatchCentricPreview(content, tokens, previewMax, { preferDebugLines }),
    };
  } catch {
    return null;
  }
}

/** Preload root HTML/CSS/JS when the task is a static-site → framework migration. */
async function seedRootEntryFiles(
  task: string,
  maxFiles: number,
  scored: ScoredFile[],
  preferDebug = false,
): Promise<ScoredFile[]> {
  if (!taskWantsSourceFileContext(task)) return scored;
  const tokens = Array.from(new Set(tokenize(task)));
  const have = new Set(scored.map((f) => f.path.replace(/\\/g, "/")));
  const toTry: string[] = [];
  for (const p of STATIC_WEB_ROOT_FILES) {
    if (!have.has(p)) toTry.push(p);
  }
  for (const ep of pathsMentionedInTask(task)) {
    const norm = ep.replace(/\\/g, "/").replace(/^\.\//, "");
    if (!have.has(norm) && !toTry.includes(norm)) toTry.push(norm);
  }
  const added: ScoredFile[] = [];
  for (const rel of toTry) {
    if (scored.length + added.length >= maxFiles) break;
    const sf = await scoredFileFromPath(rel, 180, tokens, preferDebug);
    if (sf) {
      added.push(sf);
      have.add(sf.path);
    }
  }
  const merged = [...scored, ...added];
  merged.sort((a, b) => b.score - a.score);
  return merged.slice(0, maxFiles);
}

export async function rankRelevant(task: string, maxFiles: number): Promise<ScoredFile[]> {
  const tokens = Array.from(new Set(tokenize(task)));
  const explicitPaths = pathsMentionedInTask(task).map((p) => p.toLowerCase());
  const preferDebug = looksLikeDebugTask(task);
  const semantic = await semanticBoostForTask(task);

  if (tokens.length === 0 && explicitPaths.length === 0) {
    const anchors = await defaultEntryPaths(maxFiles);
    const seeded: ScoredFile[] = [];
    for (const rel of anchors) {
      const sf = await scoredFileFromPath(rel, 100, tokens, preferDebug);
      if (sf) seeded.push(sf);
    }
    return seedRootEntryFiles(task, maxFiles, seeded, preferDebug);
  }

  const paths = await walkPaths(".");
  const pathScores: { abs: string; rel: string; score: number }[] = [];

  for (const abs of paths) {
    const rel = toRel(abs);
    const norm = rel.replace(/\\/g, "/");
    const ps = pathOnlyScore(norm, tokens, explicitPaths, semantic);
    if (ps > 0) pathScores.push({ abs, rel: norm, score: ps });
  }

  for (const [rel, boost] of semantic) {
    if (pathScores.some((p) => p.rel === rel)) continue;
    try {
      const abs = safeJoin(rel);
      pathScores.push({ abs, rel, score: boost });
    } catch {
      /* outside workspace */
    }
  }

  pathScores.sort((a, b) => b.score - a.score);
  const readCap = Math.max(maxFiles * 8, 24);
  const candidates = pathScores.slice(0, readCap);

  const tight = process.env.LLM_CONTEXT_BUDGET === "tight";
  const previewMax = tight ? 420 : preferDebug ? 640 : 600;
  const scored: ScoredFile[] = [];

  for (const c of candidates) {
    let score = c.score;
    let content = "";
    try {
      const stat = await fs.stat(c.abs);
      if (stat.size > 512 * 1024) continue;
      content = await fs.readFile(c.abs, "utf8");
    } catch {
      continue;
    }

    const lower = content.toLowerCase();
    for (const tok of tokens) {
      const occ = lower.split(tok).length - 1;
      if (occ > 0) score += Math.min(occ, 10);
    }

    const importLines = content.match(/^\s*(import|from|require)\b.*$/gm) ?? [];
    for (const line of importLines) {
      const ll = line.toLowerCase();
      for (const tok of tokens) {
        if (ll.includes(tok)) score += 2;
      }
    }

    if (score > 0) {
      scored.push({
        path: c.rel,
        score,
        preview: buildMatchCentricPreview(content, tokens, previewMax, { preferDebugLines: preferDebug }),
      });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return seedRootEntryFiles(task, maxFiles, scored.slice(0, maxFiles), preferDebug);
}
