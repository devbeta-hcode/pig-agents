/**
 * Disclosure chevron: points down when expanded, right when collapsed.
 * Replaces tiny Unicode ▾/▸ with a consistent SVG stroke icon.
 */
export function ChevronExpand({
  expanded,
  className,
  size = 14,
  /** When true (e.g. dropdown open), rotates 180° from “down” to “up”. */
  flipOpen,
}: {
  expanded: boolean;
  className?: string;
  size?: number;
  flipOpen?: boolean;
}) {
  return (
    <span
      className={[
        "chevron-expand",
        expanded ? "is-expanded" : "is-collapsed",
        flipOpen ? "is-flipped" : "",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      aria-hidden
    >
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        <path
          d="M6 9l6 6 6-6"
          stroke="currentColor"
          strokeWidth="2.25"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

/** Small “play” glyph for terminal shell rows (replaces ▶). */
export function PlayTriangle({ className, size = 11 }: { className?: string; size?: number }) {
  return (
    <span className={["play-triangle", className].filter(Boolean).join(" ")} aria-hidden>
      <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
        <path d="M8 5v14l11-7z" />
      </svg>
    </span>
  );
}
