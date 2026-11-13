type Kind = "home" | "files" | "changes" | "terminal" | "browser";

export function ArtifactIcon({ kind, size = 16 }: { kind: Kind; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {kind === "home" && <><circle cx="12" cy="12" r="9" /><path d="m16 8-2.5 5.5L8 16l2.5-5.5Z" /></>}
      {kind === "files" && <><path d="M3 4h7l3 3h8v3" /><path d="M3 9h8l2 2h8v10H3Z" fill="currentColor" stroke="none" /></>}
      {kind === "changes" && <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M12 4v16M5.5 12h4M14.5 12h4M16.5 10v4" /></>}
      {kind === "terminal" && <path d="m5 5 7 7-7 7M14 19h6" strokeWidth="2.6" />}
      {kind === "browser" && <><circle cx="12" cy="12" r="9" /><ellipse cx="12" cy="12" rx="4" ry="9" /><path d="M3 12h18" /></>}
    </svg>
  );
}
