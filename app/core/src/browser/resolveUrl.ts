import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getWorkspace, safeJoin } from "../utils/workspace.js";

const WEB_URL = /^https?:\/\//i;
const LOCALHOST = /^localhost(:\d+)?(\/|$)/i;

/** True when url points at a file under the open workspace (file://). */
export function isWorkspaceFileUrl(url: string): boolean {
  if (!url.startsWith("file:")) return false;
  try {
    const ws = path.resolve(getWorkspace());
    const abs = path.resolve(fileURLToPath(url));
    const wsKey = ws.toLowerCase();
    const absKey = abs.toLowerCase();
    return absKey === wsKey || absKey.startsWith(wsKey + path.sep.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Normalize browser_navigate input: https URLs, localhost, workspace-relative HTML,
 * and file:// paths under WORKSPACE_PATH.
 */
export function resolveBrowserNavigateUrl(raw: string): string {
  let u = raw.trim();
  if (!u || u === "about:blank") return "about:blank";

  const embedded = u.match(/https?:\/\/[^\s<>"']+/i);
  if (embedded) u = embedded[0];

  if (WEB_URL.test(u) || u.startsWith("about:") || u.startsWith("file:")) return u;

  if (LOCALHOST.test(u) || /^127\.0\.0\.1(:\d+)?(\/|$)/.test(u)) {
    return `http://${u.replace(/^\/\//, "")}`;
  }

  const looksLikeFile =
    /\.(html?|htm)(\?|#|$)/i.test(u) ||
    /^[\w.@+-/\\]+\.(html?|htm)$/i.test(u) ||
    (!u.includes("://") && !u.includes(" ") && /\.(html?|htm)$/i.test(u));

  if (looksLikeFile && !WEB_URL.test(u)) {
    const rel = u.replace(/^[/\\]+/, "");
    const abs = safeJoin(rel);
    return pathToFileURL(abs).href;
  }

  return `https://${u}`;
}
