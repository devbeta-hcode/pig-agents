/**
 * Project-root anchors for context ranking (entry files, config) — token-cheap orientation.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { safeJoin } from "../utils/workspace.js";

const ANCHOR_FILES = [
  "package.json",
  "tsconfig.json",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "AGENTS.md",
  "README.md",
] as const;

/** Extra score when a path is a known project anchor or primary app source. */
export function projectPathBoost(rel: string): number {
  const p = rel.replace(/\\/g, "/").replace(/^\.\//, "");
  if ((ANCHOR_FILES as readonly string[]).includes(p)) return 40;
  if (/^(app|src|lib|packages)\//i.test(p)) return 4;
  if (p.endsWith("/index.ts") || p.endsWith("/index.tsx") || p.endsWith("/main.ts")) return 6;
  return 0;
}

/** Paths to try when the task has no keywords (empty ranking). */
export async function defaultEntryPaths(limit = 4): Promise<string[]> {
  const out: string[] = [];
  for (const f of ANCHOR_FILES) {
    if (out.length >= limit) break;
    try {
      await fs.stat(safeJoin(f));
      out.push(f);
    } catch {
      /* missing */
    }
  }
  if (out.length >= limit) return out.slice(0, limit);

  try {
    const pkgTxt = await fs.readFile(safeJoin("package.json"), "utf8");
    const pkg = JSON.parse(pkgTxt) as {
      main?: string;
      module?: string;
      exports?: Record<string, unknown> | string;
    };
    const candidates = [
      typeof pkg.main === "string" ? pkg.main : "",
      typeof pkg.module === "string" ? pkg.module : "",
    ].filter(Boolean);
    if (pkg.exports && typeof pkg.exports === "object" && !Array.isArray(pkg.exports)) {
      const dot = pkg.exports["."];
      if (typeof dot === "string") candidates.push(dot);
      else if (dot && typeof dot === "object" && "import" in dot) {
        const imp = (dot as { import?: string }).import;
        if (typeof imp === "string") candidates.push(imp);
      }
    }
    for (const raw of candidates) {
      if (out.length >= limit) break;
      const norm = raw.replace(/^\.\//, "").split(":")[0]!;
      if (norm && !out.includes(norm)) out.push(norm);
    }
  } catch {
    /* no package.json */
  }

  return out.slice(0, limit);
}
