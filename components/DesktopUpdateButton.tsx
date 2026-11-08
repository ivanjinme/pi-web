"use client";

import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { DesktopUpdateState } from "@/lib/desktop-update";

export function DesktopUpdateButton() {
  const { locale, t } = useI18n();
  const [state, setState] = useState<DesktopUpdateState>({ status: "idle" });
  const acknowledgedReady = useRef(false);

  useEffect(() => {
    const bridge = window.weclioDesktop;
    if (!bridge) return;

    let active = true;
    let receivedEvent = false;
    const unsubscribe = bridge.onUpdateState((nextState) => {
      receivedEvent = true;
      if (active) setState(nextState);
    });
    void bridge.getUpdateState().then((snapshot) => {
      // 订阅后的事件优先，避免较旧的快照覆盖下载完成状态。
      if (active && !receivedEvent) setState(snapshot);
    }).catch((error: unknown) => {
      console.error("Failed to load desktop update state:", error);
    });

    if (!acknowledgedReady.current && bridge.applicationReady) {
      acknowledgedReady.current = true;
      void bridge.applicationReady().catch((error: unknown) => {
        console.error("Failed to acknowledge desktop application ready:", error);
      });
    }

    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  if (state.status === "downloading" || state.status === "preparing") {
    const label = t(state.status === "downloading"
      ? "desktopUpdate.downloading"
      : state.phase === "extracting"
        ? "desktopUpdate.extracting"
        : state.phase === "verifying"
          ? "desktopUpdate.verifying"
          : "desktopUpdate.preparing");
    const progress = typeof state.progress === "number" && Number.isFinite(state.progress)
      ? Math.round(Math.min(100, Math.max(0, state.progress)))
      : undefined;
    const visible = state.status === "preparing" || progress !== undefined;
    const status = progress === undefined ? label : t("desktopUpdate.progress", { status: label, progress });

    return (
      <span className="desktop-update-downloading" role="status" aria-label={status}>
        <svg className="desktop-update-spinner" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M21 12a9 9 0 1 1-9-9" />
        </svg>
        {visible && <span>{status}</span>}
      </span>
    );
  }

  if (state.status === "error") {
    return (
      <span className="desktop-update-error">
        <span role="status">{t("desktopUpdate.error")}</span>
        {window.weclioDesktop?.checkForUpdates && (
          <button type="button" className="desktop-update-button" onClick={retryUpdate}>
            {t("desktopUpdate.retry")}
          </button>
        )}
      </span>
    );
  }

  if (state.status !== "downloaded") return null;

  async function retryUpdate() {
    try {
      await window.weclioDesktop?.checkForUpdates?.();
    } catch (error) {
      console.error("Failed to retry desktop update:", error);
    }
  }

  async function restartUpdate() {
    try {
      await window.weclioDesktop?.restartUpdate(locale);
    } catch (error) {
      console.error("Failed to restart desktop update:", error);
    }
  }

  return (
    <button type="button" className="desktop-update-button" onClick={restartUpdate}>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 3v12m-4-4 4 4 4-4M5 16v4h14v-4" />
      </svg>
      <span>{t("desktopUpdate.restart")}</span>
    </button>
  );
}
