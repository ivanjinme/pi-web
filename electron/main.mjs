import { app, BrowserWindow, dialog, shell } from "electron";
import { SERVER_URL, isAppUrl, isExternalUrl, isPermissionAllowed } from "./navigation.mjs";

app.setName("Weclio");
let mainWindow = null;

function showError(message) {
  console.error(`[desktop] ${message}`);
  dialog.showErrorBox("Weclio 桌面启动失败", message);
  app.exit(1);
}

app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => console.log("[desktop] 正在退出。"));
app.on("child-process-gone", (_event, details) => {
  console.error(`[desktop] ${details.type} 进程退出: ${details.reason} (${details.exitCode})`);
});

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    title: "Weclio",
    width: 1440,
    height: 960,
    minWidth: 800,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
    },
  });

  // 主窗口的生命周期由主进程持有，不依赖局部回调引用。
  mainWindow = window;
  window.once("closed", () => {
    console.log("[desktop] 窗口已关闭。");
    if (mainWindow === window) mainWindow = null;
  });
  window.once("ready-to-show", () => {
    console.log("[desktop] 首帧就绪，显示窗口。");
    window.show();
  });
  window.webContents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
    if (isMainFrame) console.error(`[desktop] 页面加载失败: ${code} ${description} ${url}`);
  });
  window.webContents.on("console-message", (event) => {
    if (event.level === "error") console.error(`[desktop] 页面错误: ${event.message}`);
  });

  window.webContents.session.setPermissionRequestHandler((_contents, permission, callback, details) => {
    callback(isPermissionAllowed(permission, details.requestingUrl));
  });
  window.webContents.session.setPermissionCheckHandler((_contents, permission, requestingOrigin) => {
    return isPermissionAllowed(permission, requestingOrigin);
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (!isAppUrl(url)) event.preventDefault();
  });
  window.webContents.on("will-redirect", (event, url) => {
    if (!isAppUrl(url)) event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isAppUrl(url)) {
      void window.loadURL(url).catch((error) => showError(error.message));
    } else if (isExternalUrl(url)) {
      // 外链仅交给浏览器，禁止 file:、自定义协议等调用本地程序。
      void shell.openExternal(url).catch((error) => dialog.showErrorBox("无法打开链接", error.message));
    }
    return { action: "deny" };
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    console.error(`[desktop] 页面进程退出: ${details.reason} (${details.exitCode})`);
    if (details.reason === "clean-exit" || window.isDestroyed()) return;
    // 页面崩溃不直接结束服务，保留窗口让用户选择恢复。
    void dialog.showMessageBox(window, {
      type: "error",
      title: "Weclio 页面进程退出",
      message: `页面进程已退出: ${details.reason} (${details.exitCode})`,
      buttons: ["重新加载", "退出"],
      defaultId: 0,
      cancelId: 1,
    }).then(({ response }) => {
      if (window.isDestroyed()) return;
      if (response === 0) window.reload();
      else app.quit();
    }).catch((error) => console.error("[desktop] 无法显示恢复提示:", error));
  });
  await window.loadURL(SERVER_URL);
}).catch((error) => showError(error.message));
