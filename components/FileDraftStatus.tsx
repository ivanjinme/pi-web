"use client";
import { useEffect, useSyncExternalStore, type ReactElement } from "react";
import type { FileDraftCoordinator } from "@/lib/file-draft";
import { useI18n } from "@/hooks/useI18n";
import { getFileName } from "@/lib/file-paths";

interface Props {
  coordinator: FileDraftCoordinator;
  onOpen: (path: string) => void;
}

export function FileDraftStatus({ coordinator, onOpen }: Props): ReactElement | null {
  const problems = useSyncExternalStore(coordinator.subscribe, coordinator.getProblems, coordinator.getProblems);
  const { t } = useI18n();
  useEffect(() => {
    function warn(event: BeforeUnloadEvent): void {
      if (!coordinator.getProblems().length) return;
      event.preventDefault();
      event.returnValue = "";
    }
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [coordinator]);
  const failed = problems.filter((snapshot) => snapshot.status === "failed");
  if (!failed.length) return null;
  return (
    <aside className="file-draft-errors" role="alert">
      {failed.map((snapshot) => (
        <div key={snapshot.path}>
          <button onClick={() => onOpen(snapshot.path)}>{getFileName(snapshot.path)}</button>
          <span>{t("files.saveFailed")}: {snapshot.error}</span>
          <button onClick={() => void coordinator.flush(snapshot.path)}>{t("files.retry")}</button>
        </div>
      ))}
    </aside>
  );
}
