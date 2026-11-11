"use client";

import { useRef, type KeyboardEvent } from "react";
import type { ArtifactTab } from "@/lib/artifact-tabs";
import { getFileIcon } from "./FileIcons";
import { ArtifactIcon } from "./ArtifactIcon";
import { useI18n } from "@/hooks/useI18n";

interface Props {
  tabs: ArtifactTab[];
  activeTabId: string;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onOpenHome: () => void;
}

export function TabBar({ tabs, activeTabId, onSelectTab, onCloseTab, onOpenHome }: Props) {
  const { locale, t } = useI18n();
  const listRef = useRef<HTMLDivElement>(null);
  const homeLabel = locale === "zh-CN" ? "首页" : "Home";

  function navigate(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next: number;
    switch (event.key) {
      case "ArrowLeft": next = (index - 1 + tabs.length) % tabs.length; break;
      case "ArrowRight": next = (index + 1) % tabs.length; break;
      case "Home": next = 0; break;
      case "End": next = tabs.length - 1; break;
      default: return;
    }
    event.preventDefault();
    onSelectTab(tabs[next].id);
    listRef.current?.querySelectorAll<HTMLButtonElement>("[role='tab']")[next]?.focus();
  }

  return (
    <div className="artifact-tabbar">
      <div className="artifact-tablist" role="tablist" aria-label={locale === "zh-CN" ? "工作区" : "Workspace"} ref={listRef}>
        {tabs.map((tab, index) => {
          const active = tab.id === activeTabId;
          const label = tab.kind === "file" ? tab.label : tab.kind === "home" ? homeLabel : tab.kind === "files" ? "Files" : "Changes";
          return (
            <div className={`artifact-tab${active ? " is-active" : ""}`} key={tab.id}
              onMouseDown={(event) => { if (event.button === 1) event.preventDefault(); }}
              onAuxClick={(event) => {
                if (event.button === 1) { event.preventDefault(); onCloseTab(tab.id); }
              }}>
              <button type="button" role="tab" aria-selected={active} tabIndex={active ? 0 : -1}
                className="artifact-tab-select" title={tab.kind === "file" ? tab.filePath : label}
                onClick={() => onSelectTab(tab.id)} onKeyDown={(event) => navigate(event, index)}>
                {tab.kind === "file" ? getFileIcon(tab.label, 13) : <ArtifactIcon kind={tab.kind} size={14} />}
                <span>{label}</span>
              </button>
              <button type="button" className="artifact-tab-close" onClick={() => onCloseTab(tab.id)} aria-label={`${t("i18n.close")} ${label}`}>
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="m2 2 6 6m0-6L2 8" /></svg>
              </button>
            </div>
          );
        })}
      </div>
      <button type="button" className="right-workspace-icon artifact-add-tab" onClick={onOpenHome} title={homeLabel} aria-label={homeLabel}>
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M8 3v10M3 8h10" /></svg>
      </button>
    </div>
  );
}
