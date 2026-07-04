// SSE is one-way (server → client) but the policy gate is two-way: the
// runner needs to *pause*, wait for the user's click in the browser, then
// continue with the answer. We bridge that here.
//
// Flow:
//
//   runner ─┐
//           ▼
//     waitForApproval(askId, cmd, …)
//        │ creates pending Promise indexed by askId
//        │ runner blocks on this Promise
//        ▼ (returns when client POSTs answer)
//
//   frontend ──POST /agent/approvals/:askId──► resolveApproval(askId, decision)
//        │ resolves the Promise
//        ▼ runner unblocks and either runs the command or aborts
//
// Each pending request has an idle timeout (default 5 min) so a forgotten
// browser tab can't pin a runner forever. Aborting the runner also rejects
// all of its pending approvals via `cancelAllForRun(runId)`.

export type ApprovalDecision = "allow_once" | "allow_always" | "deny";

export interface ApprovalAnswer {
  decision: ApprovalDecision;
  /** If the user used "Edit & allow", the cmd they actually want to run. */
  editedCmd?: string;
}

interface Pending {
  runId?: string;
  cmd: string;
  resolve: (a: ApprovalAnswer) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  createdAt: number;
}

const pending = new Map<string, Pending>();

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 min

let counter = 0;
export function newAskId(): string {
  counter += 1;
  return `ask-${Date.now().toString(36)}-${counter.toString(36)}`;
}

export function waitForApproval(
  askId: string,
  cmd: string,
  opts: { runId?: string; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<ApprovalAnswer> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise<ApprovalAnswer>((resolve, reject) => {
    // If the run was already aborted (e.g. stream closed before we parked),
    // fail fast instead of registering a pending that nothing will resolve.
    if (opts.signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      pending.delete(askId);
      reject(new Error(`approval timeout after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    // Reject the moment the run aborts. Without this, a stream close that only
    // fires the AbortSignal (no cancelAllForRun reaching us) would leave this
    // Promise — and its timer — alive for the full idle timeout, hanging the run.
    const onAbort = () => {
      clearTimeout(timer);
      pending.delete(askId);
      reject(new Error("aborted"));
    };
    const cleanup = () => {
      opts.signal?.removeEventListener("abort", onAbort);
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    pending.set(askId, {
      runId: opts.runId,
      cmd,
      resolve: (a) => { cleanup(); resolve(a); },
      reject: (e) => { cleanup(); reject(e); },
      timer,
      createdAt: Date.now(),
    });
  });
}

export function resolveApproval(askId: string, answer: ApprovalAnswer): boolean {
  const p = pending.get(askId);
  if (!p) return false;
  clearTimeout(p.timer);
  pending.delete(askId);
  p.resolve(answer);
  return true;
}

export function cancelAllForRun(runId: string, reason = "run aborted"): number {
  let n = 0;
  for (const [askId, p] of pending) {
    if (p.runId === runId) {
      clearTimeout(p.timer);
      pending.delete(askId);
      p.reject(new Error(reason));
      n += 1;
    }
  }
  return n;
}

/** Snapshot for diagnostics / debugging. */
export function listPending(): Array<{ askId: string; runId?: string; cmd: string; ageMs: number }> {
  const now = Date.now();
  return Array.from(pending.entries()).map(([askId, p]) => ({
    askId,
    runId: p.runId,
    cmd: p.cmd,
    ageMs: now - p.createdAt,
  }));
}
