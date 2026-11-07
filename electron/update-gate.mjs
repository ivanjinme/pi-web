import { randomUUID } from "node:crypto";

export function createUpdateGate(child) {
  const pending = new Map();
  let failure;

  const sendUnlock = () => {
    if (!child.connected) return;
    try {
      child.send({ type: "weclio-desktop-update", id: randomUUID(), action: "unlock" }, (error) => {
        if (error) close(error);
      });
    } catch (error) { close(error); }
  };
  const close = (error) => {
    if (failure) return;
    failure = error;
    child.off("message", onMessage);
    child.off("error", onError);
    child.off("disconnect", onDisconnect);
    child.off("exit", onExit);
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  };
  const onMessage = (message) => {
    if (!message || typeof message !== "object") return;
    const entry = pending.get(message.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(message.id);
    if (message.type !== "weclio-desktop-update-result" || (message.status !== "ready" && message.status !== "busy") || (entry.action === "unlock" && message.status !== "ready")) {
      if (entry.action === "lock") sendUnlock();
      entry.reject(new Error("Malformed desktop update gate reply"));
    } else {
      entry.resolve(message.status);
    }
  };
  const onError = (error) => close(error);
  const onDisconnect = () => close(new Error("Desktop update IPC disconnected"));
  const onExit = () => close(new Error("Desktop update server exited"));
  child.on("message", onMessage);
  child.on("error", onError);
  child.on("disconnect", onDisconnect);
  child.on("exit", onExit);

  const request = (action) => new Promise((resolve, reject) => {
    if (failure) return reject(failure);
    if (!child.connected) {
      onDisconnect();
      return reject(failure);
    }
    if (pending.size >= 32) return reject(new Error("Too many desktop update gate requests"));
    const id = randomUUID();
    const timer = setTimeout(() => {
      pending.delete(id);
      // 同一通道保证迟到的 lock 后面必有 unlock，无需租约或轮询。
      if (action === "lock") sendUnlock();
      reject(new Error("Desktop update gate request timed out"));
    }, 5_000);
    pending.set(id, { action, resolve, reject, timer });
    try {
      child.send({ type: "weclio-desktop-update", id, action }, (error) => {
        if (error) close(error);
      });
    } catch (error) { close(error); }
  });

  return {
    inspect: () => request("inspect"),
    lock: () => request("lock"),
    unlock: async () => { await request("unlock"); },
    dispose: ({ unlock = true } = {}) => {
      if (!failure && unlock) sendUnlock();
      close(new Error("Desktop update gate disposed"));
    },
  };
}
