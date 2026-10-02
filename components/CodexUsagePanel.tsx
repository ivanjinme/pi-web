"use client";

import { useId, useState } from "react";
import type { CodexUsage, CodexUsageWindow } from "@/lib/codex-usage";

function percent(window: CodexUsageWindow | null) {
  return window ? `${Number(window.remainingPercent.toFixed(1))}%` : "unavailable";
}

export function formatCodexResetTime(reset: Date) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(reset.getHours())}:${pad(reset.getMinutes())} ${pad(reset.getMonth() + 1)}-${pad(reset.getDate())}`;
}

function UsageWindow({ label, window }: { label: string; window: CodexUsageWindow | null }) {
  const resetAt = window?.resetAt;
  const reset = resetAt ? new Date(resetAt) : null;
  return (
    <div className="codex-usage-window">
      <span>{label}</span>
      <span className="codex-usage-percent">{percent(window)}</span>
      {reset ? (
        <time dateTime={resetAt ?? undefined} title={reset.toLocaleString()}>
          {formatCodexResetTime(reset)}
        </time>
      ) : <span className="codex-usage-reset">unavailable</span>}
      {window && (
        <span className="codex-usage-progress" role="progressbar" aria-label={`${label} remaining`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={window.remainingPercent}>
          {Array.from({ length: 10 }, (_, index) => (
            <span key={index} aria-hidden="true" data-filled={index < Math.round(window.remainingPercent / 10)} />
          ))}
        </span>
      )}
    </div>
  );
}

export function CodexUsagePanel({ usage }: { usage: CodexUsage | null }) {
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const available = usage?.status === "available" ? usage : null;
  const summary = !usage ? "—" : available ? percent(available.primary) : "unavailable";
  return (
    <div className="codex-usage-panel">
      <button type="button" role="menuitem" aria-expanded={expanded} aria-controls={detailsId} onClick={() => setExpanded((open) => !open)}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
        <span className="codex-usage-label">Usage remaining <span>{summary}</span></span>
        <span className="codex-usage-chevron" aria-hidden="true">›</span>
      </button>
      {expanded && (
        <div id={detailsId} className="codex-usage-details" role="group" aria-label="Codex usage remaining" aria-live="polite">
          {!usage ? <span>Loading…</span> : !available ? <span>unavailable</span> : (
            <>
              <UsageWindow label="5 hour" window={available.primary} />
              <UsageWindow label="Weekly" window={available.secondary} />
            </>
          )}
        </div>
      )}
    </div>
  );
}
