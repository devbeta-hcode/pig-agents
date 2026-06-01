/**
 * In-memory text buffers for open files. Only one FileEditor mounts at a time;
 * buffers keep unsaved text and dirty state when switching tabs.
 */

export interface FileBuffer {
  content: string;
  /** Last saved or last explicit disk load — baseline for dirty detection. */
  original: string;
}

const buffers = new Map<string, FileBuffer>();
/** Paths cleared by invalidate — block writes until the next disk load. */
const invalidatedPaths = new Set<string>();

/** Ignore CRLF vs LF; Monaco may normalize on programmatic load. */
export function normalizeEditorText(s: string): string {
  return s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function isEditorDirty(content: string, original: string): boolean {
  return normalizeEditorText(content) !== normalizeEditorText(original);
}

export function getFileBuffer(path: string): FileBuffer | undefined {
  return buffers.get(path);
}

export function writeFileBuffer(path: string, content: string, original: string): void {
  if (invalidatedPaths.has(path)) return;
  buffers.set(path, { content, original });
}

export function isPathDirtyInBuffer(path: string): boolean {
  const buf = buffers.get(path);
  return !!buf && isEditorDirty(buf.content, buf.original);
}

export function invalidateEditorBuffer(path?: string): void {
  if (path) {
    buffers.delete(path);
    invalidatedPaths.add(path);
  } else {
    buffers.clear();
    invalidatedPaths.clear();
  }
}

/** Allow buffering again after a fresh disk read (e.g. reopen after discard). */
export function reviveEditorBuffer(path: string): void {
  invalidatedPaths.delete(path);
}

export function hasFileBuffer(path: string): boolean {
  return buffers.has(path);
}

/** Disk read may refresh a clean buffer; never stomp unsaved edits. */
export function shouldApplyDiskRead(path: string): boolean {
  return !isPathDirtyInBuffer(path);
}
