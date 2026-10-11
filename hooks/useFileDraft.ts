"use client";
import { useEffect, useSyncExternalStore } from "react";
import { FileDraftCoordinator, type DraftSnapshot, type FileReadResult } from "@/lib/file-draft";
import { encodeFilePathForApi } from "@/lib/file-paths";

export function createFileDraftCoordinator(onSaved: (path: string) => void): FileDraftCoordinator {
  return new FileDraftCoordinator(async (path, text) => {
    const response = await fetch(`/api/files/${encodeFilePathForApi(path)}`, {
      method: "PUT", headers: { "Content-Type": "text/plain; charset=utf-8" }, body: text,
    });
    const result = await response.json() as { error?: string };
    if (!response.ok) throw new Error(result.error ?? "Failed to save file");
  }, async (path, sessionId) => {
    const params = new URLSearchParams({ type: "read" });
    if (sessionId) params.set("sessionId", sessionId);
    const response = await fetch(`/api/files/${encodeFilePathForApi(path)}?${params}`);
    const result = await response.json() as FileReadResult & { error?: string };
    if (!response.ok) throw new Error(result.error ?? "Failed to read file");
    return result;
  }, onSaved);
}

export function useFileDraft(coordinator: FileDraftCoordinator, path: string): DraftSnapshot | null {
  const snapshot = useSyncExternalStore(coordinator.subscribe, () => coordinator.get(path), () => null);
  useEffect(() => {
    coordinator.retain(path);
    return () => coordinator.release(path);
  }, [coordinator, path]);
  return snapshot;
}
