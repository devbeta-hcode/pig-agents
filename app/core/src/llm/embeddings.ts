import { resolveIntegrationBaseUrl } from "./integrations.js";
import { normalizeLlmProviderId } from "./profiles.js";

function embeddingsUrl(): string {
  const pid = normalizeLlmProviderId(process.env.LLM_PROVIDER);
  const base = resolveIntegrationBaseUrl(pid, process.env.BASE_URL);
  if (/\/v1$/i.test(base)) return `${base}/embeddings`;
  return `${base}/v1/embeddings`;
}

function embeddingModel(): string {
  return process.env.EMBEDDING_MODEL?.trim() || "text-embedding-3-small";
}

function authHeader(): Record<string, string> {
  const key = process.env.OPENAI_API_KEY || "local";
  return { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
}

/** OpenAI-compatible embeddings (single batch). */
export async function createEmbeddings(
  inputs: string[],
  signal?: AbortSignal,
): Promise<number[][]> {
  if (inputs.length === 0) return [];
  const url = embeddingsUrl();
  const res = await fetch(url, {
    method: "POST",
    headers: authHeader(),
    body: JSON.stringify({ model: embeddingModel(), input: inputs }),
    signal,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Embeddings ${url} returned ${res.status}: ${t.slice(0, 800)}`);
  }
  const data = (await res.json()) as {
    data?: { embedding?: number[]; index?: number }[];
  };
  const rows = data.data ?? [];
  rows.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  return rows.map((r) => r.embedding ?? []);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d === 0 ? 0 : dot / d;
}
