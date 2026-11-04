import { app, BrowserWindow, dialog, shell } from "electron";
import { SERVER_URL, isAppUrl, isExternalUrl, isPermissionAllowed } from "./navigation.mjs";
import { startProductionServer } from "./production.mjs";

app.setName("Weclio");
let mainWindow = null;
let service = null;
let quitting = false;
const startup = new AbortController();

function showError(message) {
  service?.stop();
  console.error(`[desktop] ${message}`);
  dialog.showErrorBox("Weclio 桌面启动失败", message);
  app.exit(1);
}

app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => {
  console.log("[desktop] 正在退出。");
  quitting = true;
  service?.stop();
  startup.abort();
});
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
    ...(process.platform === "win32" ? {
      titleBarStyle: "hidden",
      titleBarOverlay: { color: "#f8f7ff", symbolColor: "#1d1e21", height: 40 },
    } : {}),
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

  if (process.platform === "win32") {
    // Electron 原生全屏不会更新覆盖层 visible，需要单独同步此只读展示状态。
    const syncFullscreen = () => {
      void window.webContents.executeJavaScript(
        `document.documentElement.toggleAttribute("data-native-fullscreen", ${window.isFullScreen()})`,
      ).catch((error) => console.error("[desktop] 无法同步全屏状态:", error));
    };
    window.on("enter-full-screen", syncFullscreen);
    window.on("leave-full-screen", syncFullscreen);
    window.webContents.on("dom-ready", syncFullscreen);
    window.webContents.on("did-change-theme-color", (_event, color) => {
      if (!color) return;
      // Electron 将 theme-color 规范化为 #rrggbb，按亮度选择原生按钮前景色。
      const rgb = Number.parseInt(color.slice(1), 16);
      const brightness = ((rgb >> 16) * 299 + ((rgb >> 8) & 255) * 587 + (rgb & 255) * 114) / 1000;
      window.setTitleBarOverlay({ color, symbolColor: brightness < 128 ? "#f0f1f2" : "#1d1e21" });
    });
  }

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
    if (isExternalUrl(url) || (isAppUrl(url) && new URL(url).protocol === "http:")) {
      // 弹出链接交给浏览器，避免完整历史等页面替换主界面；禁止本地协议。
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
  if (app.isPackaged) {
    // 先显示可关闭的启动页；异步初始化不能让慢磁盘上的首次启动看起来毫无响应。
    const html = '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Weclio</title><style>body{margin:0;background:#f8f7ff;color:#1d1e21;font:16px system-ui;display:grid;place-content:center;min-height:100vh}h1{font-size:24px;font-weight:500}p{color:#625e70}</style><main role="status"><h1>正在启动 Weclio</h1><p>首次打开需要准备内置扩展与技能，请稍候。</p></main></html>';
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    service = await startProductionServer({
      resourcesPath: process.resourcesPath,
      logsPath: app.getPath("logs"),
      url: SERVER_URL,
      signal: startup.signal,
      onUnexpectedExit: (error) => showError(error.message),
    });
  }
  if (!quitting) await window.loadURL(SERVER_URL);
}).catch((error) => { if (!quitting) showError(error.message); });
