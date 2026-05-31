/**
 * True when revert API failed because the path is missing on disk — the tray
 * row should still be removed so the UI does not loop on alerts / broken open.
 */
export function revertTargetFileMissing(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err);
  return /\bfile not found\b/i.test(m) || /\bnot found:\s*\S+/i.test(m);
}
