type GateState = { locked: boolean; pending: number; registered: boolean };

declare global {
  var __weclioDesktopUpdateGate: GateState | undefined;
}

function state(): GateState {
  return globalThis.__weclioDesktopUpdateGate ??= { locked: false, pending: 0, registered: false };
}

// 在首个 await 前占位，覆盖 SDK 尚未设置运行标记的窗口。
export function beginDesktopTask(): () => void {
  const gate = state();
  if (gate.locked) throw new Error("Desktop update in progress; please try again after updating");
  gate.pending++;
  return () => { gate.pending--; };
}

export function desktopUpdateStatus(lock: boolean, isBusy: () => boolean): "ready" | "busy" {
  const gate = state();
  if (gate.pending > 0 || isBusy()) return "busy";
  if (lock) gate.locked = true;
  return "ready";
}

export function unlockDesktopUpdate(): void {
  state().locked = false;
}

export function registerDesktopUpdateGate(isBusy: () => boolean): void {
  if (process.env.NODE_ENV !== "production" || process.env.WECLIO_DESKTOP_UPDATE_IPC !== "1" || !process.send || !process.connected) return;
  const gate = state();
  if (gate.registered) return;
  gate.registered = true;
  // 同一有序通道内同步处理；lock/unlock 之间不能插入异步加载。
  process.on("message", (message: unknown) => {
    if (!message || typeof message !== "object") return;
    const request = message as Record<string, unknown>;
    if (request.type !== "weclio-desktop-update" || typeof request.id !== "string") return;
    if (request.action !== "inspect" && request.action !== "lock" && request.action !== "unlock") return;
    if (request.action === "unlock") unlockDesktopUpdate();
    const status = request.action === "unlock" ? "ready" : desktopUpdateStatus(request.action === "lock", isBusy);
    if (process.connected) process.send?.({ type: "weclio-desktop-update-result", id: request.id, status }, (error) => {
      if (error) unlockDesktopUpdate();
    });
  });
  process.once("disconnect", unlockDesktopUpdate);
}
