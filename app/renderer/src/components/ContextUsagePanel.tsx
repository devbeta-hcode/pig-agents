import { useEffect, useRef } from "react";
import { IconX } from "./Icons";
import {
  type ContextUsage,
  formatContextTokens,
} from "../lib/contextEstimate";

interface Props {
  estimate: ContextUsage;
  modelLabel?: string;
  onClose: () => void;
}

function ContextRing({ percent, size = 18 }: { percent: number; size?: number }) {
  const r = (size - 3) / 2;
  const c = 2 * Math.PI * r;
  const offset = c * (1 - Math.min(100, percent) / 100);
  const stroke =
    percent >= 90 ? "var(--bad)" : percent >= 75 ? "var(--warn)" : "var(--accent-2)";
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="rgba(255,255,255,0.12)"
        strokeWidth="2.5"
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={stroke}
        strokeWidth="2.5"
        strokeDasharray={c}
        strokeDashoffset={offset}
        strokeLinecap="round"
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  );
}

function sourceLabel(source: ContextUsage["source"]): string {
  if (source === "api") return "Provider API";
  if (source === "preview") return "Composed prompt";
  return "Measured prompt";
}

export function ContextUsageTrigger({
  estimate,
  open,
  onToggle,
}: {
  estimate: ContextUsage;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className={`context-usage-trigger ${open ? "is-open" : ""}`}
      onClick={onToggle}
      title="Context window usage"
      aria-expanded={open}
      aria-haspopup="dialog"
    >
      <ContextRing percent={estimate.percent} />
      <span className="context-usage-trigger-pct">{estimate.percent}%</span>
    </button>
  );
}

export function ContextUsagePanel({ estimate, modelLabel, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const fullLabel = estimate.percent >= 90 ? "Full" : estimate.percent >= 75 ? "High" : "OK";
  const totalPrefix = estimate.source === "api" ? "" : "~";

  return (
    <div className="context-usage-panel" ref={ref} role="dialog" aria-label="Context usage">
      <div className="context-usage-panel-head">
        <span className="context-usage-panel-title">Context</span>
        <button type="button" className="context-usage-panel-close" onClick={onClose} aria-label="Close">
          <IconX size={14} />
        </button>
      </div>
      <div className="context-usage-panel-summary">
        <span className={`context-usage-panel-badge ${estimate.percent >= 90 ? "warn" : ""}`}>
          {estimate.percent}% {fullLabel}
        </span>
        <span className="context-usage-panel-total">
          {totalPrefix}{formatContextTokens(estimate.totalTokens)} / {formatContextTokens(estimate.limitTokens)} input tokens
        </span>
      </div>
      {estimate.completionTokens != null && estimate.completionTokens > 0 && (
        <div className="context-usage-panel-model">
          Output this call: {formatContextTokens(estimate.completionTokens)} tokens
        </div>
      )}
      {modelLabel && (
        <div className="context-usage-panel-model">{modelLabel}</div>
      )}
      <div
        className="context-usage-bar"
        role="meter"
        aria-valuenow={estimate.percent}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        {estimate.segments.map((s) => (
          <div
            key={s.id}
            className="context-usage-bar-seg"
            style={{
              flex: s.tokens,
              backgroundColor: s.color,
            }}
            title={`${s.label}: ${formatContextTokens(s.tokens)}${s.chars != null ? ` (${s.chars.toLocaleString()} chars)` : ""}`}
          />
        ))}
      </div>
      <ul className="context-usage-legend">
        {estimate.segments.map((s) => (
          <li key={s.id}>
            <span className="context-usage-legend-dot" style={{ backgroundColor: s.color }} />
            <span className="context-usage-legend-label">{s.label}</span>
            <span className="context-usage-legend-val">{formatContextTokens(s.tokens)}</span>
          </li>
        ))}
      </ul>
      <p className="context-usage-hint">
        {sourceLabel(estimate.source)}
        {estimate.trimmed ? " · context was trimmed for budget" : ""}
        {estimate.source !== "api" ? " · segment sizes from the actual prompt sent to the model" : ""}
      </p>
    </div>
  );
}
