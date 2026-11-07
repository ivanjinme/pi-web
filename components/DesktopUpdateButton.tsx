"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { DesktopUpdateState } from "@/lib/desktop-update";

export function DesktopUpdateButton() {
  const { locale, t } = useI18n();
  const [state, setState] = useState<DesktopUpdateState>({ status: "idle" });

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

    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  if (state.status === "downloading") {
    return (
      <span className="desktop-update-downloading" role="status" aria-label={t("desktopUpdate.downloading")}>
        <svg className="desktop-update-spinner" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M21 12a9 9 0 1 1-9-9" />
        </svg>
      </span>
    );
  }

  if (state.status !== "downloaded") return null;

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
