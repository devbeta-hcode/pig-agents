/**
 * Semantic code search via OpenAI-compatible embeddings API (no extra npm deps).
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { getWorkspace } from "../utils/workspace.js";
import { safeJoin, toRel } from "../utils/workspace.js";
import { createEmbeddings, cosineSimilarity } from "../llm/embeddings.js";

const INDEX_SKIP = new Set([
  "node_modules", ".git", "dist", "build", ".next", "release",
]);

const CODE_EXT = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".go", ".rs", ".java", ".cs",
  ".md", ".json", ".html", ".css", ".scss", ".vue",
]);

const PRIORITY_REL = [
  "package.json",
  "tsconfig.json",
  "AGENTS.md",
  "README.md",
  "app/core/src",
  "app/renderer/src",
  "src/",
];

interface ChunkRecord {
  id: string;
  path: string;
  startLine: number;
  text: string;
  embedding: number[];
}

interface IndexFile {
  version: 1;
  workspace: string;
  model: string;
  chunks: ChunkRecord[];
}

let mem: { ws: string; chunks: ChunkRecord[] } | null = null;

function workspaceKey(): string {
  return crypto.createHash("sha256").update(getWorkspace()).digest("hex").slice(0, 16);
}

function cachePath(): string {
  const base = process.env.PIG_INDEX_DIR?.trim() || path.join(os.homedir(), ".pig-agents", "index");
  return path.join(base, `${workspaceKey()}.json`);
}

function chunkFile(rel: string, content: string, maxChunk = 720): { startLine: number; text: string }[] {
  const lines = content.split(/\r?\n/);
  const out: { startLine: number; text: string }[] = [];
  let buf: string[] = [];
  let start = 1;
  const flush = (endLine: number) => {
    const joined = buf.join("\n").trim();
    if (!joined) return;
    out.push({ startLine: start, text: `${rel}:${start}\n${joined}` });
    buf = [];
    start = endLine + 1;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    buf.push(line);
    const joined = buf.join("\n");
    const atBoundary =
      /^(export\s+)?(async\s+)?function\s+\w+|^export\s+class\s+|^class\s+\w+|^export\s+(const|interface|type)\s+\w+/m.test(
        line,
      ) && buf.length > 3;
    if (joined.length >= maxChunk || atBoundary || i === lines.length - 1) {
      flush(i + 1);
    }
  }
  return out;
}

function filePriority(rel: string): number {
  const p = rel.replace(/\\/g, "/");
  for (let i = 0; i < PRIORITY_REL.length; i++) {
    if (p === PRIORITY_REL[i] || p.startsWith(PRIORITY_REL[i])) return PRIORITY_REL.length - i;
  }
  return 0;
}

async function walkFiles(limit: number): Promise<string[]> {
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
  await walk(safeJoin("."));
  out.sort((a, b) => filePriority(toRel(b)) - filePriority(toRel(a)));
  return out;
}

async function loadDisk(): Promise<IndexFile | null> {
  try {
    const txt = await fs.readFile(cachePath(), "utf8");
    const j = JSON.parse(txt) as IndexFile;
    if (j?.version !== 1 || j.workspace !== getWorkspace()) return null;
    return j;
  } catch {
    return null;
  }
}

async function saveDisk(chunks: ChunkRecord[]): Promise<void> {
  const p = cachePath();
  await fs.mkdir(path.dirname(p), { recursive: true });
  const data: IndexFile = {
    version: 1,
    workspace: getWorkspace(),
    model: process.env.EMBEDDING_MODEL?.trim() || "text-embedding-3-small",
    chunks,
  };
  await fs.writeFile(p, JSON.stringify(data), "utf8");
}

export async function ensureEmbeddingIndex(force = false): Promise<number> {
  const ws = getWorkspace();
  if (!force && mem && mem.ws === ws && mem.chunks.length > 0) return mem.chunks.length;

  if (!force) {
    const disk = await loadDisk();
    if (disk?.chunks?.length) {
      mem = { ws, chunks: disk.chunks };
      return disk.chunks.length;
    }
  }

  const fileCap = Math.min(160, Math.max(60, Number(process.env.EMBEDDING_INDEX_MAX_FILES || 120)));
  const files = await walkFiles(fileCap);
  const rawChunks: { path: string; startLine: number; text: string }[] = [];
  for (const abs of files) {
    const rel = toRel(abs);
    try {
      const st = await fs.stat(abs);
      if (st.size > 300 * 1024) continue;
      const content = await fs.readFile(abs, "utf8");
      rawChunks.push(...chunkFile(rel, content).map((c) => ({ path: rel, ...c })));
      if (rawChunks.length >= 240) break;
    } catch {
      /* skip */
    }
  }

  if (rawChunks.length === 0) {
    mem = { ws, chunks: [] };
    return 0;
  }

  const batchSize = 32;
  const records: ChunkRecord[] = [];
  for (let i = 0; i < rawChunks.length; i += batchSize) {
    const batch = rawChunks.slice(i, i + batchSize);
    const vectors = await createEmbeddings(batch.map((b) => b.text));
    for (let j = 0; j < batch.length; j++) {
      records.push({
        id: `${batch[j].path}:${batch[j].startLine}`,
        path: batch[j].path,
        startLine: batch[j].startLine,
        text: batch[j].text,
        embedding: vectors[j] ?? [],
      });
    }
  }

  mem = { ws, chunks: records };
  try {
    await saveDisk(records);
  } catch {
    /* non-fatal */
  }
  return records.length;
}

export async function semanticSearch(query: string, topK = 8): Promise<{ path: string; line: number; score: number; excerpt: string }[]> {
  const q = query.trim();
  if (!q) return [];
  await ensureEmbeddingIndex(false);
  if (!mem?.chunks.length) return [];

  const [qVec] = await createEmbeddings([q]);
  if (!qVec?.length) return [];

  const ranked = mem.chunks
    .map((c) => ({
      path: c.path,
      line: c.startLine,
      score: cosineSimilarity(qVec, c.embedding),
      excerpt: c.text.slice(0, 400),
    }))
    .filter((r) => r.score > 0.18)
    .sort((a, b) => b.score - a.score);

  return ranked.slice(0, topK).map((r) => ({
    ...r,
    excerpt: r.excerpt.split("\n").slice(0, 8).join("\n").slice(0, 280),
  }));
}

/** Paths boosted for first-turn FILES ranking (no extra embedding call). */
export async function semanticPathScores(
  query: string,
  limit = 6,
): Promise<Map<string, number>> {
  const hits = await semanticSearch(query, limit);
  const m = new Map<string, number>();
  for (const h of hits) {
    const prev = m.get(h.path) ?? 0;
    m.set(h.path, Math.max(prev, h.score * 80));
  }
  return m;
}
