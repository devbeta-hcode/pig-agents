import { memo } from "react";
import { IconAlertTriangle, IconCheck } from "./Icons";

/** Subtle setup / context line in the agent timeline (Cursor-style, not a banner box). */
export function TraceActivityRow({ label }: { label: string }) {
  return (
    <div className="trace-log-flat trace-log-flat--activity">
      <span className="trace-log-dot" aria-hidden />
      <span className="trace-log-msg">{label}</span>
    </div>
  );
}

export const TraceLogRow = memo(function TraceLogRow({
  level,
  message,
}: {
  level: "info" | "warn" | "error";
  message: string;
}) {
  const lvl = level === "error" ? "error" : level === "warn" ? "warn" : "info";
  return (
    <div className={`trace-log-flat trace-log-flat--${lvl}`}>
      <span className={`trace-log-lvl trace-log-lvl--${lvl}`}>
        {level === "error" ? "ERR" : level === "warn" ? "WARN" : "LOG"}
      </span>
      <span className="trace-log-msg">{message}</span>
    </div>
  );
});

export function TracePolicyRow({
  decision,
  cmd,
  reason,
}: {
  decision: string;
  cmd?: string;
  reason?: string;
}) {
  const deny = decision === "deny";
  return (
    <div className={`trace-log-flat trace-log-flat--policy ${deny ? "trace-log-flat--deny" : ""}`}>
      {deny ? (
        <IconAlertTriangle size={12} className="trace-log-policy-icon" aria-hidden />
      ) : (
        <IconCheck size={12} className="trace-log-policy-icon" aria-hidden />
      )}
      <span className="trace-log-msg">
        {deny ? "Blocked" : "Allowed"}: <code className="trace-log-cmd">{cmd || "command"}</code>
        {reason ? <span className="trace-log-policy-reason"> — {reason}</span> : null}
      </span>
    </div>
  );
}
