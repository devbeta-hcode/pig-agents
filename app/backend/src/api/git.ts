// Git "Source Control" REST API.
//
// Wraps the local `git` CLI inside the current workspace and exposes the bits
// the VSCode-style sidebar needs: status, file diff (working tree or staged),
// staging actions, commit, and a recent commit log.
//
// All responses are JSON. We always run `git` with `cwd: getWorkspace()` so
// the active workspace is the unit of operation. If the workspace is not a
// git repo we report `{ ok: false, reason: "not_a_repo" }` so the UI can
// degrade gracefully (offer "Initialize Repository", etc.).

import { Router } from "express";
import { promisify } from "util";
import { execFile as execFileCb } from "child_process";

import { getWorkspace } from "../utils/workspace.js";
import { runGit, isRepo, type GitRunResult } from "../utils/git.js";

const execFile = promisify(execFileCb);

export const gitRouter = Router();

// `runGit` / `isRepo` were lifted into `utils/git.ts` so the checkpoint
// engine and command-policy code can share the same git plumbing without
// having to import this Express router. Re-export the result type so
// existing local consumers below keep compiling.
export type { GitRunResult };

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

interface GitFileEntry {
  /** Repo-relative path (POSIX separators). */
  path: string;
  /** Original path for renames/copies, else null. */
  origPath: string | null;
  /** Two-char porcelain code, e.g. " M", "M ", "MM", "??", "A ", "R ". */
  code: string;
  /** Friendly index-side status: M | A | D | R | C | U | T | ? | space. */
  indexStatus: string;
  /** Friendly worktree-side status: M | A | D | R | C | U | T | ? | space. */
  workStatus: string;
  /** True when this file has staged changes (index column != " "). */
  staged: boolean;
  /** True when this file has unstaged changes (worktree column != " "). */
  unstaged: boolean;
  /** True for `??` entries (file is not yet tracked). */
  untracked: boolean;
}

/**
 * Parse `git status --porcelain=v1 -z` output. The `-z` form uses NUL
 * separators (instead of newlines) so paths with whitespace, quotes, or
 * unicode are unambiguous.
 */
function parsePorcelainZ(out: string): GitFileEntry[] {
  const entries: GitFileEntry[] = [];
  if (!out) return entries;
  // Each entry: "XY <path>\0" or for renames/copies: "XY <new>\0<old>\0"
  const tokens = out.split("\0");
  // Drop trailing empty token from the final NUL.
  if (tokens.length && tokens[tokens.length - 1] === "") tokens.pop();
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.length < 3) continue;
    const code = t.slice(0, 2);
    const rest = t.slice(3); // skip the space after XY
    const indexStatus = code[0];
    const workStatus = code[1];
    let p = rest;
    let orig: string | null = null;
    if (indexStatus === "R" || indexStatus === "C" || workStatus === "R" || workStatus === "C") {
      // The next token is the source path for the rename/copy.
      orig = tokens[i + 1] ?? null;
      i += 1;
    }
    const untracked = code === "??";
    entries.push({
      path: p,
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

gitRouter.get("/git/status", async (_req, res) => {
  try {
    if (!(await isRepo())) {
      return res.json({ ok: false, reason: "not_a_repo", workspace: getWorkspace() });
    }
    // Branch + ahead/behind in one shot via `--branch`.
    const sb = await runGit(["status", "--porcelain=v1", "-z", "--branch", "--untracked-files=all"]);
    if (sb.exitCode !== 0) {
      return res.status(400).json({ ok: false, error: sb.stderr.trim() || "git status failed" });
    }
    // With -z, the branch header is the FIRST entry in the NUL-split stream
    // and ends at the first NUL. It is NOT followed by a status code so we
    // peel it off separately.
    let branchLine = "";
    let body = sb.stdout;
    const firstNul = body.indexOf("\0");
    if (firstNul >= 0 && body.startsWith("##")) {
      branchLine = body.slice(0, firstNul);
      body = body.slice(firstNul + 1);
    } else {
      // Fallback — branch header missing for some reason.
      const nl = body.indexOf("\n");
      if (nl >= 0 && body.startsWith("##")) {
        branchLine = body.slice(0, nl);
        body = body.slice(nl + 1);
      }
    }
    const files = parsePorcelainZ(body);

    // Branch header looks like:
    //   "## main...origin/main [ahead 2, behind 1]"
    //   "## main...origin/main"
    //   "## main"
    //   "## HEAD (no branch)"
    //   "## No commits yet on main"
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

    res.json({
      ok: true,
      workspace: getWorkspace(),
      branch,
      upstream,
      ahead,
      behind,
      detached,
      files,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ---------------------------------------------------------------------------
// Diff for one path (working tree against index, or index against HEAD).
// ---------------------------------------------------------------------------

gitRouter.get("/git/diff", async (req, res) => {
  try {
    if (!(await isRepo())) {
      return res.status(400).json({ error: "Not a git repository" });
    }
    const p = String(req.query.path ?? "").trim();
    const staged = String(req.query.staged ?? "0") === "1";
    const untracked = String(req.query.untracked ?? "0") === "1";
    if (!p) return res.status(400).json({ error: "path required" });

    if (untracked) {
      // Untracked files have no index entry — synthesize a diff against
      // /dev/null so the editor still has something to render.
      const r = await runGit(["diff", "--no-color", "--no-index", "--", "/dev/null", p]);
      // `git diff --no-index` exits with 1 when there ARE differences (which
      // is always true for untracked files); only treat -1 / runtime errors
      // as failures.
      if (r.exitCode < 0) {
        return res.status(400).json({ error: r.stderr.trim() || "git diff failed" });
      }
      return res.json({ path: p, staged: false, untracked: true, diff: r.stdout });
    }

    const args = ["diff", "--no-color"];
    if (staged) args.push("--cached");
    args.push("--", p);
    const r = await runGit(args);
    if (r.exitCode !== 0 && r.exitCode !== 1) {
      return res.status(400).json({ error: r.stderr.trim() || "git diff failed" });
    }
    res.json({ path: p, staged, untracked: false, diff: r.stdout });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ---------------------------------------------------------------------------
// Stage / unstage / discard
// ---------------------------------------------------------------------------

function readPaths(body: unknown): string[] {
  if (!body || typeof body !== "object") return [];
  const raw = (body as { paths?: unknown }).paths;
  if (!Array.isArray(raw)) return [];
  return raw.filter((p): p is string => typeof p === "string" && p.length > 0);
}

gitRouter.post("/git/stage", async (req, res) => {
  try {
    if (!(await isRepo())) return res.status(400).json({ error: "Not a git repository" });
    const paths = readPaths(req.body);
    if (paths.length === 0) return res.status(400).json({ error: "paths required" });
    const r = await runGit(["add", "--", ...paths]);
    if (r.exitCode !== 0) return res.status(400).json({ error: r.stderr.trim() || "git add failed" });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

gitRouter.post("/git/unstage", async (req, res) => {
  try {
    if (!(await isRepo())) return res.status(400).json({ error: "Not a git repository" });
    const paths = readPaths(req.body);
    if (paths.length === 0) return res.status(400).json({ error: "paths required" });
    // `git restore --staged` is the modern, safe form (works on initial
    // commit too; falls back to `git reset HEAD --` only if restore is missing).
    const r = await runGit(["restore", "--staged", "--", ...paths]);
    if (r.exitCode !== 0) {
      const fb = await runGit(["reset", "HEAD", "--", ...paths]);
      if (fb.exitCode !== 0) {
        return res.status(400).json({ error: fb.stderr.trim() || r.stderr.trim() || "unstage failed" });
      }
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

gitRouter.post("/git/discard", async (req, res) => {
  try {
    if (!(await isRepo())) return res.status(400).json({ error: "Not a git repository" });
    const paths = readPaths(req.body);
    if (paths.length === 0) return res.status(400).json({ error: "paths required" });
    // Restore the working-tree copy to whatever is in the index.
    const r = await runGit(["checkout", "--", ...paths]);
    if (r.exitCode !== 0) {
      return res.status(400).json({ error: r.stderr.trim() || "discard failed" });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ---------------------------------------------------------------------------
// Commit
// ---------------------------------------------------------------------------

gitRouter.post("/git/commit", async (req, res) => {
  try {
    if (!(await isRepo())) return res.status(400).json({ error: "Not a git repository" });
    const body = (req.body ?? {}) as { message?: unknown; stageAll?: unknown; signoff?: unknown };
    const message = typeof body.message === "string" ? body.message.trim() : "";
    const stageAll = body.stageAll === true;
    const signoff = body.signoff === true;
    if (!message) return res.status(400).json({ error: "message required" });

    if (stageAll) {
      const add = await runGit(["add", "-A"]);
      if (add.exitCode !== 0) {
        return res.status(400).json({ error: add.stderr.trim() || "git add -A failed" });
      }
    }

    const args = ["commit", "-m", message];
    if (signoff) args.push("--signoff");
    const r = await runGit(args);
    if (r.exitCode !== 0) {
      return res.status(400).json({ error: r.stderr.trim() || r.stdout.trim() || "commit failed" });
    }
    res.json({ ok: true, output: r.stdout });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ---------------------------------------------------------------------------
// Log (commit history)
// ---------------------------------------------------------------------------

interface GitLogEntry {
  hash: string;
  abbrev: string;
  parents: string[];
  author: string;
  email: string;
  /** ISO-8601 author date. */
  date: string;
  /** Unix epoch (seconds) — handy for sorting / relative time. */
  ts: number;
  /** Subject line only (first line of commit message). */
  subject: string;
}

gitRouter.get("/git/log", async (req, res) => {
  try {
    if (!(await isRepo())) {
      return res.json({ ok: false, reason: "not_a_repo", entries: [] });
    }
    const limit = Math.max(1, Math.min(500, parseInt(String(req.query.limit ?? "50"), 10) || 50));

    // Use NUL-separated records so commit subjects with `|` etc. don't break us.
    const FMT = ["%H", "%h", "%P", "%an", "%ae", "%aI", "%at", "%s"].join("%x1f") + "%x00";
    const r = await runGit(["log", `--max-count=${limit}`, `--pretty=format:${FMT}`]);
    if (r.exitCode !== 0) {
      // Empty repo (no HEAD yet) ⇒ git log fails; treat as empty list.
      if (/does not have any commits yet|bad default revision/i.test(r.stderr)) {
        return res.json({ ok: true, entries: [] });
      }
      return res.status(400).json({ error: r.stderr.trim() || "git log failed" });
    }
    // `git log --pretty=format:` emits a separator newline between records,
    // which then sticks to the start of the *next* record after we split on
    // %x00. Trim the leading whitespace per record before parsing.
    const records = r.stdout
      .split("\0")
      .map((x) => x.replace(/^[\r\n]+/, ""))
      .filter((x) => x.length > 0);
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
    res.json({ ok: true, entries });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ---------------------------------------------------------------------------
// Apply a (partial) patch — used by per-hunk Stage / Discard / Unstage.
//
// The UI splits the file diff into single-hunk patches and sends them here.
// We then map intent → `git apply` flags:
//   stage   → --cached             (apply hunk to index)
//   discard → --reverse            (revert hunk in working tree)
//   unstage → --cached --reverse   (undo a staged hunk in the index)
// ---------------------------------------------------------------------------

gitRouter.post("/git/apply", async (req, res) => {
  try {
    if (!(await isRepo())) return res.status(400).json({ error: "Not a git repository" });
    const body = (req.body ?? {}) as {
      patch?: unknown;
      mode?: unknown; // "stage" | "discard" | "unstage"
    };
    const patch = typeof body.patch === "string" ? body.patch : "";
    const mode = typeof body.mode === "string" ? body.mode : "";
    if (!patch.trim()) return res.status(400).json({ error: "patch required" });

    const args = ["apply", "--whitespace=nowarn", "--unidiff-zero"];
    if (mode === "stage") {
      args.push("--cached");
    } else if (mode === "discard") {
      args.push("--reverse");
    } else if (mode === "unstage") {
      args.push("--cached", "--reverse");
    } else {
      return res.status(400).json({ error: "mode must be stage | discard | unstage" });
    }

    // Ensure trailing newline — `git apply` is picky about that.
    const input = patch.endsWith("\n") ? patch : patch + "\n";
    const r = await runGit(args, { input });
    if (r.exitCode !== 0) {
      return res.status(400).json({
        error: r.stderr.trim() || r.stdout.trim() || "git apply failed",
      });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ---------------------------------------------------------------------------
// init (offered when the workspace is not yet a git repo)
// ---------------------------------------------------------------------------

gitRouter.post("/git/init", async (_req, res) => {
  try {
    if (await isRepo()) return res.json({ ok: true, alreadyRepo: true });
    const r = await runGit(["init"]);
    if (r.exitCode !== 0) {
      return res.status(400).json({ error: r.stderr.trim() || "git init failed" });
    }
    res.json({ ok: true, output: r.stdout });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ---------------------------------------------------------------------------
// Tiny health probe — useful to confirm the binary exists from the UI.
// ---------------------------------------------------------------------------

gitRouter.get("/git/version", async (_req, res) => {
  try {
    const { stdout } = await execFile("git", ["--version"], { timeout: 3000 });
    res.json({ ok: true, version: stdout.trim() });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// Re-export a tiny convenience type for the frontend if it ever wants to
// import it via a shared module — kept inline so we don't grow a `types/`
// dir for a single feature.
export type { GitFileEntry, GitLogEntry };
