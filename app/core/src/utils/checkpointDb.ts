/**
 * Checkpoint **metadata** in `<workspace>/.pig-agents/checkpoints.json` only.
 * Git refs and `~/.pig-agents/backups` for real snapshots are unchanged in
 * `checkpoints.ts`. (Any old `checkpoints.db` from earlier versions is ignored.)
 */

import fs from "node:fs";
import path from "node:path";
import type { Checkpoint } from "./checkpoints.js";

export const META_DIR = ".pig-agents";
export const LEGACY_META_FILE = "checkpoints.json";

function metaPath(ws: string): string {
  return path.join(ws, META_DIR, LEGACY_META_FILE);
}

interface CheckpointFile {
  version: 1;
  checkpoints: Checkpoint[];
}

function readJsonMeta(ws: string): CheckpointFile {
  const p = metaPath(ws);
  try {
    const txt = fs.readFileSync(p, "utf8");
    const obj = JSON.parse(txt) as CheckpointFile;
    if (obj && obj.version === 1 && Array.isArray(obj.checkpoints)) return obj;
  } catch {
    /* missing or bad */
  }
  return { version: 1, checkpoints: [] };
}

function writeJsonMeta(ws: string, data: CheckpointFile): void {
  fs.mkdirSync(path.join(ws, META_DIR), { recursive: true });
  fs.writeFileSync(metaPath(ws), JSON.stringify(data, null, 2));
}

/** No-op (kept for API stability; there is no DB handle to close). */
export function closeCheckpointDb(_ws: string): void {
  /* noop */
}

export function loadAllCheckpoints(ws: string): Checkpoint[] {
  const cps = readJsonMeta(ws).checkpoints;
  return [...cps].sort((a, b) => a.createdAt - b.createdAt);
}

export function appendCheckpoint(ws: string, cp: Checkpoint): void {
  const meta = readJsonMeta(ws);
  meta.checkpoints.push(cp);
  writeJsonMeta(ws, meta);
}

export function deleteCheckpointRow(ws: string, id: string): boolean {
  const meta = readJsonMeta(ws);
  const idx = meta.checkpoints.findIndex((c) => c.id === id);
  if (idx === -1) return false;
  meta.checkpoints.splice(idx, 1);
  writeJsonMeta(ws, meta);
  return true;
}

export function trimRing(ws: string, maxKeep: number): Checkpoint[] {
  const meta = readJsonMeta(ws);
  if (meta.checkpoints.length <= maxKeep) return [];
  const sorted = [...meta.checkpoints].sort((a, b) => a.createdAt - b.createdAt);
  const dropCount = meta.checkpoints.length - maxKeep;
  const dropped = sorted.slice(0, dropCount);
  const dropIds = new Set(dropped.map((d) => d.id));
  meta.checkpoints = meta.checkpoints.filter((c) => !dropIds.has(c.id));
  writeJsonMeta(ws, meta);
  return dropped;
}

/**
 * Append recovered checkpoint rows without overwriting existing ids (used when
 * rebuilding `.pig-agents/checkpoints.json` from git refs or file backups).
 */
export function mergeRecoveredCheckpoints(ws: string, recovered: Checkpoint[]): number {
  if (recovered.length === 0) return 0;
  const meta = readJsonMeta(ws);
  const have = new Set(meta.checkpoints.map((c) => c.id));
  let added = 0;
  for (const cp of recovered) {
    if (have.has(cp.id)) continue;
    meta.checkpoints.push(cp);
    have.add(cp.id);
    added++;
  }
  if (added > 0) {
    fs.mkdirSync(path.join(ws, META_DIR), { recursive: true });
    writeJsonMeta(ws, meta);
  }
  return added;
}
