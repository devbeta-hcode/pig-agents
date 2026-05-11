import path from "node:path";
import fs from "node:fs/promises";
import { safeJoin, toRel } from "../utils/workspace.js";

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

async function walkAll(rel: string): Promise<string[]> {
  const out: string[] = [];
  const root = safeJoin(rel);
  const scanLimit = Math.max(200, Number(process.env.MAX_CONTEXT_SCAN_FILES || 1200));
  let scanned = 0;
  async function walk(dir: string) {
    if (scanned >= scanLimit) return;
    let dirents: import("node:fs").Dirent[];
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true });
    } catch { return; }
    for (const d of dirents) {
      if (scanned >= scanLimit) return;
      if (IGNORED.has(d.name)) continue;
      const full = path.join(dir, d.name);
      if (d.isDirectory()) {
        await walk(full);
      } else if (d.isFile()) {
        scanned++;
        const ext = path.extname(d.name).toLowerCase();
        if (TEXT_EXT.has(ext) || d.name.includes(".")) {
          if (TEXT_EXT.has(ext)) out.push(full);
        }
      }
    }
  }
  await walk(root);
  return out;
}

export async function rankRelevant(task: string, maxFiles: number): Promise<ScoredFile[]> {
  const tokens = Array.from(new Set(tokenize(task)));
  if (tokens.length === 0) return [];
  const files = await walkAll(".");
  const scored: ScoredFile[] = [];

  for (const abs of files) {
    let score = 0;
    const rel = toRel(abs);
    const lowerRel = rel.toLowerCase();

    for (const tok of tokens) {
      if (lowerRel.includes(tok)) score += 5;
      const baseName = path.basename(lowerRel, path.extname(lowerRel));
      if (baseName === tok) score += 8;
    }

    let content = "";
    try {
      const stat = await fs.stat(abs);
      if (stat.size > 512 * 1024) continue;
      content = await fs.readFile(abs, "utf8");
    } catch { continue; }

    const lower = content.toLowerCase();
    for (const tok of tokens) {
      const occ = lower.split(tok).length - 1;
      if (occ > 0) score += Math.min(occ, 10);
    }

    // import hint: bonus when imports reference task tokens
    const importLines = content.match(/^\s*(import|from|require)\b.*$/gm) ?? [];
    for (const line of importLines) {
      const ll = line.toLowerCase();
      for (const tok of tokens) {
        if (ll.includes(tok)) score += 2;
      }
    }

    if (score > 0) {
      // Larger previews by default (better agent quality). Use LLM_CONTEXT_BUDGET=tight for smaller slices.
      const tight = process.env.LLM_CONTEXT_BUDGET === "tight";
      const previewLen = tight
        ? score > 20 ? 520 : score > 10 ? 380 : 260
        : score > 20 ? 1000 : score > 10 ? 700 : 400;
      scored.push({ path: rel, score, preview: content.slice(0, previewLen) });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, maxFiles);
}
