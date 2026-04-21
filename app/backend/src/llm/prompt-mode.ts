/**
 * Normalizes `PROMPT_MODE` from env / settings UI into a fixed set of tiers.
 * Legacy `compact` → `balanced` (same behaviour as before).
 */

export type PromptModeId = "minimal" | "economical" | "balanced" | "detailed" | "verbose";

const VALID: readonly PromptModeId[] = ["minimal", "economical", "balanced", "detailed", "verbose"];

export function normalizePromptMode(raw: string | undefined): PromptModeId {
  const s = (raw ?? "").trim().toLowerCase();
  if (s === "compact") return "balanced";
  if ((VALID as readonly string[]).includes(s)) return s as PromptModeId;
  return "balanced";
}

/** Context attachment aggressiveness for compact builders (1 = smallest). */
export type ContextTier = 1 | 2 | 3 | 4;

export function promptModeToContextTier(mode: PromptModeId): ContextTier {
  switch (mode) {
    case "minimal":
      return 1;
    case "economical":
      return 2;
    case "balanced":
      return 3;
    case "detailed":
      return 4;
    case "verbose":
      return 4;
    default:
      return 3;
  }
}

/**
 * Completion budget per request (TPM-sensitive providers like Groq count input + max_tokens toward TPM).
 * Override globally with {@code LLM_MAX_TOKENS} (64–8192).
 */
export function maxOutputTokensForMode(mode: PromptModeId): number {
  const env = Number(process.env.LLM_MAX_TOKENS);
  if (Number.isFinite(env) && env >= 64 && env <= 8192) return Math.floor(env);
  switch (mode) {
    case "minimal":
      return 640;
    case "economical":
      return 900;
    case "balanced":
      return 1200;
    case "detailed":
      return 1500;
    case "verbose":
      return 1800;
    default:
      return 1200;
  }
}
