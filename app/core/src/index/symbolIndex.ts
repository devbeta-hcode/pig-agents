/**
 * Lightweight symbol index (LSP-like lookup without a language server).
 */

import fs from "node:fs/promises";
import path from "node:path";
import { getWorkspace, safeJoin, toRel } from "../utils/workspace.js";
import { ripgrepSearch } from "../tools/ripgrepSearch.js";

export type SymbolKind = "function" | "class" | "method" | "interface" | "type" | "const" | "variable" | "unknown";

export interface SymbolEntry {
  name: string;
  kind: SymbolKind;
  path: string;
  line: number;
  signature?: string;
}

const INDEX_SKIP = new Set([
  "node_modules", ".git", "dist", "build", ".next", "release", "coverage",
]);

const CODE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs"]);

let cachedRoot = "";
let cachedSymbols: SymbolEntry[] | null = null;

const PATTERNS: { re: RegExp; kind: SymbolKind }[] = [
  { re: /^\s*export\s+(?:async\s+)?function\s+(\w+)/gm, kind: "function" },
  { re: /^\s*(?:async\s+)?function\s+(\w+)\s*\(/gm, kind: "function" },
  { re: /^\s*export\s+class\s+(\w+)/gm, kind: "class" },
  { re: /^\s*class\s+(\w+)/gm, kind: "class" },
  { re: /^\s*export\s+interface\s+(\w+)/gm, kind: "interface" },
  { re: /^\s*interface\s+(\w+)/gm, kind: "interface" },
  { re: /^\s*export\s+type\s+(\w+)/gm, kind: "type" },
  { re: /^\s*type\s+(\w+)\s*=/gm, kind: "type" },
  { re: /^\s*export\s+const\s+(\w+)/gm, kind: "const" },
  { re: /^\s*def\s+(\w+)\s*\(/gm, kind: "function" },
  { re: /^\s*class\s+(\w+)\s*[:(]/gm, kind: "class" },
  { re: /^\s*func\s+(\w+)\s*\(/gm, kind: "function" },
  { re: /^\s*(?:pub\s+)?fn\s+(\w+)\s*\(/gm, kind: "function" },
  { re: /^\s*(?:pub\s+)?struct\s+(\w+)/gm, kind: "class" },
];

function extractSymbolsFromFile(rel: string, content: string): SymbolEntry[] {
  const out: SymbolEntry[] = [];
  const lines = content.split(/\r?\n/);
  for (const { re, kind } of PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      const name = m[1];
      if (!name || name.length < 2) continue;
      const before = content.slice(0, m.index);
      const line = before.split(/\r?\n/).length;
      const sig = lines[line - 1]?.trim().slice(0, 120);
      out.push({ name, kind, path: rel, line, signature: sig });
    }
  }
  return out;
}

async function walkCodeFiles(dir: string, limit: number): Promise<string[]> {
  const out: string[] = [];
  async function walk(abs: string) {
    if (out.length >= limit) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= limit) return;
      if (INDEX_SKIP.has(e.name)) continue;
      const full = path.join(abs, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile() && CODE_EXT.has(path.extname(e.name).toLowerCase())) {
        out.push(full);
      }
    }
  }
  await walk(dir);
  return out;
}

export async function buildSymbolIndex(force = false): Promise<SymbolEntry[]> {
  const root = getWorkspace();
  if (!force && cachedSymbols && cachedRoot === root) return cachedSymbols;

  const files = await walkCodeFiles(safeJoin("."), 400);
  const all: SymbolEntry[] = [];
  for (const abs of files) {
    const rel = toRel(abs);
    try {
      const st = await fs.stat(abs);
      if (st.size > 400 * 1024) continue;
      const content = await fs.readFile(abs, "utf8");
      all.push(...extractSymbolsFromFile(rel, content));
    } catch {
      /* skip */
    }
  }
  cachedRoot = root;
  cachedSymbols = all;
  return all;
}

export function findSymbols(query: string, limit = 20): SymbolEntry[] {
  if (!cachedSymbols) return [];
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const scored = cachedSymbols
    .map((s) => {
      const n = s.name.toLowerCase();
      let score = 0;
      if (n === q) score += 100;
      else if (n.startsWith(q)) score += 60;
      else if (n.includes(q)) score += 30;
      return { s, score };
    })
    .filter((x) => x.score > 0);
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((x) => x.s);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function findSymbolReferences(name: string, limit = 24): Promise<{ file: string; line: number; text: string }[]> {
  const n = name.trim();
  if (n.length < 2) return [];
  const rg = await ripgrepSearch(`\\b${escapeRegex(n)}\\b`, limit);
  if (rg !== null) return rg;
  return [];
}

export function formatSymbolHits(entries: SymbolEntry[]): string {
  if (entries.length === 0) return "(no symbols matched)";
  return entries
    .map((s) => `${s.path}:${s.line} ${s.kind} ${s.name}${s.signature ? ` — ${s.signature}` : ""}`)
    .join("\n");
}
