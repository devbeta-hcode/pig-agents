import type { NextFunction, Request, Response } from "express";
import { getWorkspace, runWithWorkspace, workspaceFromRequestHeader } from "../utils/workspace.js";

/**
 * Binds `getWorkspace()` for this HTTP request to either
 * `X-Build-Agents-Workspace` (per browser tab) or the server default.
 */
export function workspaceMiddleware(req: Request, res: Response, next: NextFunction) {
  let abs: string;
  try {
    const fromHeader = workspaceFromRequestHeader(req);
    abs = fromHeader ?? getWorkspace();
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }
  runWithWorkspace(abs, () => next());
}
