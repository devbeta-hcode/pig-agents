/**
 * Fast workspace search via ripgrep when available; falls back to walk+scan.
 */

import { spawn } from "node:child_process";
import { searchCode } from "./file.js";
import { getWorkspace } from "../utils/workspace.js";

export interface CodeSearchHit {
  file: string;
  line: number;
  text: string;
}

function escapeRgQuery(q: string): string {
  return q.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function runRg(args: string[], cwd: string, timeoutMs: number): Promise<{ code: number; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("rg", args, { cwd, shell: false, windowsHide: true });
    let out = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("rg timeout"));
    }, timeoutMs);
    child.stdout?.on("data", (d) => { out += String(d); });
    child.stderr?.on("data", (d) => { out += String(d); });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, out });
    });
  });
}

/** Try `rg -n` from workspace root. Returns null if rg missing. */
export async function ripgrepSearch(query: string, maxHits = 24): Promise<CodeSearchHit[] | null> {
  const q = query.trim();
  if (q.length < 2) return null;
  const cwd = getWorkspace();
  const args = [
    "-F",
    "-n",
    "--no-heading",
    "--max-columns",
    "100",
    "-m",
    "2",
    "-g",
    "!node_modules",
    "-g",
    "!.git",
    "-g",
    "!dist",
    q,
  ];
  try {
    const { code, out } = await runRg(args, cwd, 12_000);
    if (code !== 0 && code !== 1) return null;
    if (!out.trim()) return code === 1 ? [] : null;
    const hits: CodeSearchHit[] = [];
    for (const line of out.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const m = /^(.+?):(\d+):(.*)$/.exec(line);
      if (!m) continue;
      let file = m[1].replace(/\\/g, "/");
      if (file.startsWith("./")) file = file.slice(2);
      hits.push({
        file,
        line: parseInt(m[2], 10),
        text: m[3].trim().slice(0, 120),
      });
      if (hits.length >= maxHits) break;
    }
    return hits;
  } catch {
    return null;
  }
}

export async function searchCodeFast(query: string, max = 24): Promise<CodeSearchHit[]> {
  const rg = await ripgrepSearch(query, max);
  if (rg !== null) return rg;
  return searchCode(query, max);
}
