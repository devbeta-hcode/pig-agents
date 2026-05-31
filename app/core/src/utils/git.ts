// Shared git CLI runner. Originally lived inside `api/git.ts`; pulled out so
// other backend modules (checkpoints, agent safety net, …) can spawn git
// without importing an Express router. Behaviour intentionally matches the
// original: 1 MB stdout/stderr cap, never throws on non-zero exit, returns
// `exitCode: -1` for spawn errors so callers can distinguish "git missing"
// from "git ran but failed".

import { spawn } from "child_process";
import { getWorkspace } from "./workspace.js";

export interface GitRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface GitRunOptions {
  input?: string;
  cwd?: string;
  /**
   * Extra env vars to overlay on top of the base git env. Used by the
   * checkpoint engine to pass `GIT_INDEX_FILE` so we can write to a
   * scratch index without touching the user's real one.
   */
  env?: Record<string, string>;
}

const MAX_BYTES = 1024 * 1024;

export function runGit(args: string[], opts?: GitRunOptions): Promise<GitRunResult> {
  const cwd = opts?.cwd ?? getWorkspace();
  return new Promise<GitRunResult>((resolve) => {
    const child = spawn("git", args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C", ...(opts?.env ?? {}) },
    });
    let stdout = "";
    let stderr = "";
    let truncated = false;
    child.stdout.on("data", (d) => {
      if (stdout.length < MAX_BYTES) {
        stdout += d.toString("utf8");
        if (stdout.length > MAX_BYTES) {
          stdout = stdout.slice(0, MAX_BYTES);
          truncated = true;
        }
      }
    });
    child.stderr.on("data", (d) => {
      if (stderr.length < MAX_BYTES) stderr += d.toString("utf8");
    });
    child.on("error", (err) => {
      resolve({ stdout: "", stderr: String(err.message || err), exitCode: -1 });
    });
    child.on("close", (code) => {
      resolve({
        stdout: truncated ? stdout + "\n[truncated]" : stdout,
        stderr,
        exitCode: code ?? 0,
      });
    });
    if (opts?.input) {
      child.stdin.write(opts.input);
      child.stdin.end();
    }
  });
}

/** Returns true iff `cwd` (default workspace) sits inside a git work tree. */
export async function isRepo(cwd?: string): Promise<boolean> {
  const r = await runGit(["rev-parse", "--is-inside-work-tree"], { cwd });
  return r.exitCode === 0 && r.stdout.trim() === "true";
}
