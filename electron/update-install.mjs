// 只等待真实关闭结果；renderer 的 beforeunload 否决不能被更新流程绕过。
export function closeUpdateWindow(window) {
  if (!window || window.isDestroyed()) return Promise.resolve(true);
  const contents = window.webContents;
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      window.off("closed", onClosed);
      window.off("close", onClose);
      contents.off("will-prevent-unload", onPreventUnload);
    };
    const finish = (closed) => { cleanup(); resolve(closed); };
    const onClosed = () => finish(true);
    const onPreventUnload = () => finish(false);
    const onClose = (event) => queueMicrotask(() => { if (event.defaultPrevented) finish(false); });
    window.once("closed", onClosed);
    window.on("close", onClose);
    contents.once("will-prevent-unload", onPreventUnload);
    try { window.close(); }
    catch (error) { cleanup(); reject(error); }
  });
}

export function createUpdateInstaller({ app, getService, getWindow, getGate, dialog, restoreWindow, log = console.error }) {
  let phase = "idle";
  let gate;
  let unsubscribe;
  let disposed = false;
  let language;

  async function message(type, zh, en) {
    const options = { type, title: language === "zh-CN" ? "Weclio 更新" : "Weclio update", message: language === "zh-CN" ? zh : en, buttons: [language === "zh-CN" ? "知道了" : "Got it"], defaultId: 0, cancelId: 0 };
    const window = getWindow();
    return window && !window.isDestroyed() ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options);
  }

  async function unlock() {
    const current = gate;
    gate = undefined;
    if (current) await current.unlock();
  }

  async function recover(error) {
    if (disposed || phase === "recovering" || phase === "idle") return;
    phase = "recovering";
    unsubscribe?.(); unsubscribe = undefined;
    log("[desktop-update]", error.message);
    try { await unlock(); }
    catch (releaseError) { log("[desktop-update] unlock:", releaseError.message); }
    try {
      await restoreWindow();
      await message("error", "无法安装更新，请稍后重试。", "The update could not be started. Please try again.");
    } finally { phase = "idle"; }
  }

  async function restart(locale) {
    if (disposed || phase !== "idle") return;
    language = locale;
    const service = getService();
    // 测试源未带签名安装意图，开发进程也永远不能进入安装路径。
    if (!app.isPackaged || !service?.canInstall()) {
      phase = "preview";
      try {
        await message("info", "当前仅验证更新下载，不会安装或重启。", "This preview only verifies downloads. It will not install or restart the app.");
      } finally { phase = "idle"; }
      return;
    }
    phase = "preparing";
    try {
      const current = getGate();
      if (!current) throw new Error("Desktop task gate unavailable");
      const warnBusy = () => message("warning", "有任务正在运行，请结束任务后再更新。", "Tasks are running. Finish them before updating.");
      if (await current.inspect() === "busy") { await warnBusy(); phase = "idle"; return; }
      // 点击“重启更新”本身即明确授权；不再重复询问，仍保留锁定与关闭拦截。
      if (disposed) return;
      gate = current;
      if (await current.lock() === "busy") {
        await unlock();
        await warnBusy(); phase = "idle"; return;
      }
      await service.verifyForInstall();
      if (disposed) return;
      phase = "closing";
      if (!await closeUpdateWindow(getWindow())) {
        await unlock();
        phase = "preparing";
        await message("info", "窗口未关闭，更新已取消。请保存修改后重试。", "The window was not closed, so the update was cancelled. Save your changes and try again.");
        phase = "idle";
        return;
      }
      if (disposed) return;
      // 窗口已经同意关闭；此后才允许标准 updater 启动安装器。
      phase = "handoff";
      unsubscribe = service.onInstallError((error) => { void recover(error).catch((failure) => log("[desktop-update] recovery:", failure.message)); });
      await service.quitAndInstall();
    } catch (error) { await recover(error); }
  }

  return {
    restart,
    isClosing: () => phase === "closing" || phase === "handoff" || phase === "recovering",
    isRecovering: () => phase === "recovering",
    dispose() {
      disposed = true;
      unsubscribe?.(); unsubscribe = undefined;
      if (phase !== "handoff") void unlock().catch((error) => log("[desktop-update] unlock:", error.message));
    },
  };
}
