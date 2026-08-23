"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useTheme } from "@/hooks/useTheme";
import { ModelsConfig } from "./ModelsConfig";
import { SkillsConfig } from "./SkillsConfig";
import { PluginsConfig } from "./PluginsConfig";

type SettingsPage = "general" | "models" | "skills" | "plugins";

interface Props {
  cwd: string | null;
  projectName: string | null;
  branch?: string;
  sessionId: string | null;
  projectTrusted: boolean;
  showSessionDiagnostics: boolean;
  onSessionDiagnosticsChange: (show: boolean) => void;
  onClose: () => void;
  onTrustProject: () => void;
  onPluginsReloaded: () => void;
}

export function SettingsModal({
  cwd,
  projectName,
  branch,
  sessionId,
  projectTrusted,
  showSessionDiagnostics,
  onSessionDiagnosticsChange,
  onClose,
  onTrustProject,
  onPluginsReloaded,
}: Props) {
  const { locale, setLocale, t } = useI18n();
  const { isDark, toggleTheme } = useTheme();
  const [page, setPage] = useState<SettingsPage>("general");
  const [mounted, setMounted] = useState<SettingsPage[]>(["general"]);

  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  const pages: { id: SettingsPage; label: string; icon: ReactNode }[] = [
    { id: "general", label: t("settings.general"), icon: <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z" /></svg> },
    { id: "models", label: t("common.models"), icon: <svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="2" /><rect x="9" y="9" width="6" height="6" /><path d="M9 1v3m6-3v3M9 20v3m6-3v3M20 9h3m-3 6h3M1 9h3m-3 6h3" /></svg> },
    { id: "skills", label: t("common.skills"), icon: <svg viewBox="0 0 24 24"><path d="m12 2-10 5 10 5 10-5-10-5Z" /><path d="m2 12 10 5 10-5M2 17l10 5 10-5" /></svg> },
    { id: "plugins", label: t("common.plugins"), icon: <svg viewBox="0 0 24 24"><path d="M9 7V2m6 5V2M6 13V8a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v5a6 6 0 0 1-12 0Zm6 6v3" /></svg> },
  ];

  function selectPage(next: SettingsPage) {
    setPage(next);
    setMounted((current) => current.includes(next) ? current : [...current, next]);
  }

  const contextual = page === "skills" || page === "plugins";
  const title = pages.find((item) => item.id === page)!.label;

  return (
    <div className="settings-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <header className="settings-header">
          <h2 id="settings-title">{t("settings.title")}</h2>
          <button type="button" onClick={onClose} aria-label={t("i18n.close")}>×</button>
        </header>
        <div className="settings-layout">
          <nav className="settings-nav" aria-label={t("settings.title")}>
            {pages.map((item) => (
              <button key={item.id} type="button" className={page === item.id ? "is-active" : ""} onClick={() => selectPage(item.id)}>
                {item.icon}<span>{item.label}</span>
              </button>
            ))}
          </nav>
          <main className="settings-content">
            <div className="settings-page-header">
              <div>
                <h3>{title}</h3>
                {page === "models" && <p>{t("settings.globalResources")} · ~/.pi/agent/models.json</p>}
                {contextual && (
                  cwd ? <p>{projectName}{branch ? ` · ${branch}` : ""}<code>{cwd}</code></p> : <p>{t("settings.globalResources")}</p>
                )}
                {contextual && cwd && !projectTrusted && <p>{t(page === "skills" ? "trust.skillsNotLoaded" : "trust.pluginsNotLoaded")}</p>}
              </div>
              {contextual && cwd && !projectTrusted && (
                <button type="button" className="settings-trust" onClick={onTrustProject}>{t("trust.trustProject")}</button>
              )}
            </div>
            <div className="settings-page-body">
              <section className="settings-general" hidden={page !== "general"}>
                <div className="settings-row">
                  <span>{t("settings.theme")}</span>
                  <div className="settings-segmented">
                    <button type="button" className={!isDark ? "is-active" : ""} onClick={(event) => {
                      if (!isDark) return;
                      const rect = event.currentTarget.getBoundingClientRect();
                      toggleTheme({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
                    }}>{t("settings.light")}</button>
                    <button type="button" className={isDark ? "is-active" : ""} onClick={(event) => {
                      if (isDark) return;
                      const rect = event.currentTarget.getBoundingClientRect();
                      toggleTheme({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
                    }}>{t("settings.dark")}</button>
                  </div>
                </div>
                <div className="settings-row">
                  <span>{t("common.language")}</span>
                  <div className="settings-segmented">
                    <button type="button" className={locale === "en" ? "is-active" : ""} onClick={() => setLocale("en")}>English</button>
                    <button type="button" className={locale === "zh-CN" ? "is-active" : ""} onClick={() => setLocale("zh-CN")}>简体中文</button>
                  </div>
                </div>
                <div className="settings-row">
                  <span>{t("settings.sessionDiagnostics")}</span>
                  <div className="settings-segmented">
                    <button type="button" className={!showSessionDiagnostics ? "is-active" : ""} onClick={() => onSessionDiagnosticsChange(false)}>{t("settings.hide")}</button>
                    <button type="button" className={showSessionDiagnostics ? "is-active" : ""} onClick={() => onSessionDiagnosticsChange(true)}>{t("settings.show")}</button>
                  </div>
                </div>
              </section>
              {mounted.includes("models") && <section hidden={page !== "models"}><ModelsConfig /></section>}
              {mounted.includes("skills") && <section hidden={page !== "skills"}><SkillsConfig key={`${cwd}:${projectTrusted}`} cwd={cwd} /></section>}
              {mounted.includes("plugins") && <section hidden={page !== "plugins"}><PluginsConfig key={`${cwd}:${projectTrusted}`} cwd={cwd} sessionId={sessionId} onReloaded={onPluginsReloaded} /></section>}
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}
