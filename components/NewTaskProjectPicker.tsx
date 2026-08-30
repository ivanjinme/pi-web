"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { SessionInfo } from "@/lib/types";
import { loadProjectFolders, rememberProjectFolder } from "@/lib/project-folders";
import { useI18n } from "@/hooks/useI18n";
import { DirectoryPicker } from "./DirectoryPicker";

interface Props {
  resetKey: string;
  selectedCwd: string | null;
  onSelect: (cwd: string) => void;
  onClear: () => void;
  onFocusComposer: () => void;
}

interface ProjectEntry {
  root: string;
  modified: string;
}

const normalizeRoot = (path: string): string =>
  path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

function projectName(cwd: string): string {
  return cwd.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) || cwd;
}

export function NewTaskProjectPicker({ resetKey, selectedCwd, onSelect, onClear, onFocusComposer }: Props) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  // Session-derived roots (server truth) are merged in when the popover opens;
  // localStorage folders seed the list instantly so it is never blank.
  const [entries, setEntries] = useState<ProjectEntry[]>(() =>
    loadProjectFolders().map((root) => ({ root, modified: "" })),
  );
  const [position, setPosition] = useState<{ left: number; bottom: number } | null>(null);
  const [directoryPickerOpen, setDirectoryPickerOpen] = useState(false);
  const [validating, setValidating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setOpen(false);
    setDirectoryPickerOpen(false);
    setError(null);
    setQuery("");
  }, [resetKey]);

  // Anchor the popover right above the trigger button.
  useEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.min(340, window.innerWidth - 16);
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    setPosition({ left, bottom: window.innerHeight - rect.top + 8 });
    const frame = requestAnimationFrame(() => searchRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);

  // Close on outside pointer-down and Escape.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (popoverRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);

  // Projects that actually exist on the server come from session records, so
  // the list survives cleared browser storage. localStorage only supplements.
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    fetch("/api/sessions", { signal: controller.signal })
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { sessions?: SessionInfo[] } | null) => {
        if (!data?.sessions) return;
        setEntries((previous) => {
          const byRoot = new Map<string, ProjectEntry>();
          for (const entry of previous) {
            if (!byRoot.has(normalizeRoot(entry.root))) byRoot.set(normalizeRoot(entry.root), entry);
          }
          for (const session of data.sessions ?? []) {
            const root = session.projectRoot ?? session.cwd;
            const key = normalizeRoot(root);
            const existing = byRoot.get(key);
            if (!existing || session.modified > existing.modified) byRoot.set(key, { root, modified: session.modified });
          }
          return [...byRoot.values()].sort((a, b) => {
            // Most recently active first; ties fall back to alphabetical path order.
            if (a.modified !== b.modified) return a.modified < b.modified ? 1 : -1;
            return a.root.localeCompare(b.root);
          });
        });
      })
      .catch(() => { /* aborted or offline — keep the localStorage seed */ });
    return () => controller.abort();
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter((entry) =>
      entry.root.toLowerCase().includes(q) || projectName(entry.root).toLowerCase().includes(q),
    );
  }, [entries, query]);

  const chooseProject = useCallback((cwd: string) => {
    onSelect(cwd);
    setOpen(false);
    onFocusComposer();
  }, [onFocusComposer, onSelect]);

  const clearProject = useCallback(() => {
    onClear();
    setOpen(false);
    onFocusComposer();
  }, [onClear, onFocusComposer]);

  const selectFromBrowser = useCallback(async (candidate: string) => {
    if (validating) return;
    setValidating(true);
    setError(null);
    try {
      const response = await fetch("/api/cwd/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: candidate }),
      });
      const data = await response.json().catch(() => ({})) as { cwd?: string; error?: string };
      if (!response.ok || !data.cwd) throw new Error(data.error ?? `HTTP ${response.status}`);
      rememberProjectFolder(data.cwd);
      onSelect(data.cwd);
      setDirectoryPickerOpen(false);
      onFocusComposer();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setValidating(false);
    }
  }, [onFocusComposer, onSelect, validating]);

  const selectedKey = selectedCwd ? normalizeRoot(selectedCwd) : null;
  const selectedLabel = selectedCwd ? projectName(selectedCwd) : t("chat.chooseProject");

  return (
    <div className="new-task-project-picker">
      <button
        ref={triggerRef}
        id="new-task-project-trigger"
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={selectedCwd ?? t("chat.chooseProjectHint")}
        className="new-task-project-trigger"
        style={{ color: selectedCwd ? "var(--text-muted)" : undefined, paddingRight: selectedCwd ? 2 : 8 }}
      >
        <svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M2.5 5.5h5l1.7 2h8.3v8.5h-15z" /></svg>
        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{selectedLabel}</span>
      </button>
      {selectedCwd && (
        <button
          type="button"
          className="new-task-project-clear"
          onClick={clearProject}
          title={t("chat.clearProject")}
          aria-label={t("chat.clearProject")}
        >
          <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><line x1="3" y1="3" x2="9" y2="9" /><line x1="9" y1="3" x2="3" y2="9" /></svg>
        </button>
      )}

      {open && position && createPortal(
        <div ref={popoverRef} className="project-popover" style={{ left: position.left, bottom: position.bottom }} role="dialog" aria-label={t("chat.chooseProject")}>
          <div className="project-popover-search">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><circle cx="7" cy="7" r="4.5" /><line x1="10.5" y1="10.5" x2="14" y2="14" /></svg>
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("chat.searchProjects")}
              spellCheck={false}
            />
          </div>
          <div className="project-popover-list">
            {filtered.length === 0 && (
              <div style={{ padding: "10px 9px", fontSize: 12, color: "var(--text-dim)" }}>{t("chat.noMatchingProjects")}</div>
            )}
            {filtered.map((entry) => {
              const isSelected = selectedKey === normalizeRoot(entry.root);
              return (
                <button
                  key={entry.root}
                  type="button"
                  className={`project-popover-row${isSelected ? " is-selected" : ""}`}
                  aria-current={isSelected || undefined}
                  onClick={() => chooseProject(entry.root)}
                >
                  <svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true" style={{ flexShrink: 0 }}><path d="M2.5 5.5h5l1.7 2h8.3v8.5h-15z" /></svg>
                  <span className="project-popover-row-main">
                    <span className="project-popover-name">{projectName(entry.root)}</span>
                    <span className="project-popover-path">{entry.root}</span>
                  </span>
                  {isSelected && (
                    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}><polyline points="3 8.5 6.5 12 13 4.5" /></svg>
                  )}
                </button>
              );
            })}
          </div>
          <div className="project-popover-footer">
            <button type="button" className="project-popover-action" onClick={() => { setOpen(false); setDirectoryPickerOpen(true); }}>
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><line x1="8" y1="3" x2="8" y2="13" /><line x1="3" y1="8" x2="13" y2="8" /></svg>
              {t("chat.newProject")}
            </button>
            <button type="button" className="project-popover-action" onClick={clearProject}>
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><line x1="4" y1="4" x2="12" y2="12" /><line x1="12" y1="4" x2="4" y2="12" /></svg>
              {t("chat.noProjectMode")}
            </button>
          </div>
        </div>,
        document.body,
      )}

      {directoryPickerOpen && (
        <DirectoryPicker
          busy={validating}
          error={error}
          onCancel={() => { setDirectoryPickerOpen(false); setError(null); }}
          onSelect={(cwd) => void selectFromBrowser(cwd)}
        />
      )}
    </div>
  );
}
