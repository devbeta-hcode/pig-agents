/**
 * Optional hook registered by Electron main to release UI-owned locks (PTY tabs)
 * before core deletes a path under the workspace.
 */
import path from "node:path";

let beforeDeletePath: ((targetAbs: string) => void) | null = null;

export function setBeforeDeletePathHook(fn: ((targetAbs: string) => void) | null): void {
  beforeDeletePath = fn;
}

export function invokeBeforeDeletePath(targetAbs: string): void {
  try {
    beforeDeletePath?.(path.resolve(targetAbs));
  } catch {
    /* noop */
  }
}
