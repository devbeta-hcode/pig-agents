import { buildSymbolIndex } from "./symbolIndex.js";
import { ensureEmbeddingIndex } from "./embeddingIndex.js";
import { looksLikeDebugTask, looksLikeLocalizedFixTask } from "../agent/taskShape.js";

export interface WorkspaceIndexStatus {
  symbols: number;
  embeddingChunks: number;
}

function wantSemanticIndex(task: string): boolean {
  if (process.env.LLM_DISABLE_SEMANTIC_INDEX === "1" || process.env.LLM_DISABLE_SEMANTIC_INDEX === "true") {
    return false;
  }
  if (task.length > 8) return true;
  return looksLikeDebugTask(task) || looksLikeLocalizedFixTask(task);
}

/** Build symbol + embedding indexes (cached). Call once per agent run. */
export async function warmWorkspaceIndex(task: string): Promise<WorkspaceIndexStatus> {
  const wantSemantic = wantSemanticIndex(task);
  const [symbols, chunks] = await Promise.all([
    buildSymbolIndex(false).then((s) => s.length),
    wantSemantic ? ensureEmbeddingIndex(false).catch(() => 0) : Promise.resolve(0),
  ]);
  return { symbols, embeddingChunks: chunks };
}
