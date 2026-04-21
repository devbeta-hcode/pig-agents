/**
 * Per-workspace instructions for Pig Agents — similar idea to Cursor's
 * `.cursor/rules/**`, stored under `.pig/rules/**` with optional Cursor fallback.
 */

import fs from "node:fs";
import path from "node:path";

/** Primary Pig Agents convention (commit this folder for each repo). */
export const PIG_RULES_DIR = path.join(".pig", "rules");

/** Optional: reuse existing Cursor rule files without copying them. */
export const CURSOR_RULES_DIR = path.join(".cursor", "rules");

function readRulesMaxChars(): number {
  const raw = process.env.PROJECT_RULES_MAX_CHARS;
  if (raw === undefined || raw === "") return 16_000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 500 ? Math.floor(n) : 16_000;
}

export interface LoadedProjectRules {
  /** Markdown-ish body to append after the global system prompt */
  text: string;
  /** Paths relative to workspace (`pig/rules/foo.md`) */
  relPaths: string[];
  truncated: boolean;
}

function safeRel(wsRoot: string, full: string): string {
  return path.relative(wsRoot, full).split(path.sep).join("/");
}

function collectFiles(wsRoot: string, relDir: string): string[] {
  const absDir = path.join(wsRoot, relDir);
  const out: string[] = [];
  if (!fs.existsSync(absDir) || !fs.statSync(absDir).isDirectory()) return out;

  function walk(dir: string): void {
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of dirents) {
      const full = path.join(dir, d.name);
      if (d.isDirectory()) {
        walk(full);
      } else if (d.isFile()) {
        const ext = path.extname(d.name).toLowerCase();
        if (ext === ".md" || ext === ".mdc") out.push(full);
      }
    }
  }
  walk(absDir);
  return out.sort((a, b) => a.localeCompare(b));
}

/**
 * Load all `.md` / `.mdc` files from `.pig/rules` and `.cursor/rules`.
 * Pig rules are listed first; paths are sorted within each tree.
 */
export function loadProjectRules(workspaceRoot: string): LoadedProjectRules {
  const wsRoot = path.resolve(workspaceRoot);
  const seen = new Set<string>();
  const orderedFull: string[] = [];

  for (const rel of [PIG_RULES_DIR, CURSOR_RULES_DIR]) {
    for (const full of collectFiles(wsRoot, rel)) {
      const relPath = safeRel(wsRoot, full);
      if (seen.has(relPath)) continue;
      seen.add(relPath);
      orderedFull.push(full);
    }
  }

  const relPaths = orderedFull.map((f) => safeRel(wsRoot, f));
  const parts: string[] = [];
  for (const full of orderedFull) {
    let body: string;
    try {
      body = fs.readFileSync(full, "utf8");
    } catch {
      continue;
    }
    const label = safeRel(wsRoot, full);
    parts.push(`### ${label}\n\n${body.trim()}\n`);
  }

  let text = parts.join("\n").trim();
  const maxC = readRulesMaxChars();
  let truncated = false;
  if (text.length > maxC) {
    truncated = true;
    text =
      text.slice(0, maxC).trimEnd() +
      "\n\n[Project rules truncated — raise PROJECT_RULES_MAX_CHARS if needed.]";
  }

  return { text, relPaths, truncated };
}
