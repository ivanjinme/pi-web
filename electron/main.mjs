import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { initializeUpdates, registerUpdateBridge, UPDATE_CHANNELS } from "./updates.mjs";
import { createUpdateInstaller } from "./update-install.mjs";
import { SERVER_URL, isAppUrl, isExternalUrl, isPermissionAllowed, restoreDesktopPort } from "./navigation.mjs";
import { startProductionServer } from "./production.mjs";
import { assertPortAvailable } from "./server.mjs";
import { resolveDesktopTools } from "./toolsets.mjs";
import { desktopStartupPage } from "../lib/startup-splash.mjs";

app.setName("Weclio");

// 主进程错误必须落盘：Windows 上 GUI 进程没有终端可看 stderr，
// 否则「启动失败 / 更新失败」只能靠猜（2026-11-09 就因为这一点无法定位）。
function installMainLog() {
  try {
    const directory = app.getPath("logs");
    mkdirSync(directory, { recursive: true });
    const file = join(directory, "main.log");
    try {
      if (statSync(file).size > 2 * 1024 * 1024) renameSync(file, join(directory, "main.1.log"));
    } catch {}
    const original = console.error.bind(console);
    console.error = (...args) => {
      original(...args);
      const line = args.map((value) => (value instanceof Error ? (value.stack ?? value.message) : String(value))).join(" ");
      try {
        appendFileSync(file, `${new Date().toISOString()} ${line}
`);
      } catch {}
    };
    return true;
  } catch {
    return false;
  }
}
if (!installMainLog()) app.whenReady().then(() => installMainLog());
// 同一 profile 只允许一个实例，避免并发服务争用端口与用户数据。
const holdsSingleInstance = app.requestSingleInstanceLock();
if (!holdsSingleInstance) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
}
let mainWindow = null;
let service = null;
let quitting = false;
const startup = new AbortController();
let updates = null;
const installer = createUpdateInstaller({
  app, dialog, getService: () => updates, getWindow: () => mainWindow, getGate: () => service?.updateGate,
  restoreWindow: async () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      const window = createMainWindow();
      await window.loadURL(SERVER_URL);
    }
  },
});
const removeUpdateBridge = registerUpdateBridge({ ipcMain, getWindow: () => mainWindow, isAppUrl, getService: () => updates, dialog, installer });

function showError(message) {
  service?.stop();
  console.error(`[desktop] ${message}`);
  dialog.showErrorBox("Weclio 桌面启动失败", message);
  app.exit(1);
}

app.on("window-all-closed", () => { if (!installer.isClosing()) app.quit(); });
app.on("before-quit", (event) => {
  // 标准 updater 可能已安排退出；启动失败的恢复流程必须能否决这次退出。
  if (installer.isRecovering()) event.preventDefault();
});
// before-quit 之后仍可能被 renderer 否决；只在真正退出时停止服务。
app.on("will-quit", () => {
  console.log("[desktop] 正在退出。");
  quitting = true;
  service?.stop();
  startup.abort();
  installer.dispose();
  updates?.stop();
  removeUpdateBridge();
});
app.on("child-process-gone", (_event, details) => {
  console.error(`[desktop] ${details.type} 进程退出: ${details.reason} (${details.exitCode})`);
});

function createMainWindow() {
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
      preload: fileURLToPath(new URL("./preload.cjs", import.meta.url)),
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
  return window;
}

if (holdsSingleInstance) app.whenReady().then(async () => {
  if (app.isPackaged) restoreDesktopPort(app.getPath("userData"));
  const window = createMainWindow();
  if (app.isPackaged) {
    // 先显示可关闭的启动页；异步初始化不能让慢磁盘上的首次启动看起来毫无响应。
    const html = desktopStartupPage();
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    let lastToolProgress = 0;
    const toolsetsBase = process.env.LOCALAPPDATA;
    // 端口冲突先失败，避免白白做一次首次工具迁移。
    await assertPortAvailable(Number(new URL(SERVER_URL).port || 80));
    const onToolProgress = (progress) => {
      if (quitting || window.isDestroyed() || progress.reused) return;
      const now = Date.now();
      if (progress.phase !== "ready" && now - lastToolProgress < 250) return;
      lastToolProgress = now;
      const text = `正在准备基础工具：${progress.completedFiles}/${progress.totalFiles}。后续普通更新将复用这些工具。`;
      void window.webContents.executeJavaScript(`document.querySelector('main p')?.replaceChildren(document.createTextNode(${JSON.stringify(text)}))`).catch((error) => console.error("[desktop] 无法显示工具准备进度:", error.message));
    };
    const toolsRoot = await resolveDesktopTools({ resourcesPath: process.resourcesPath, storeBase: toolsetsBase, signal: startup.signal, onProgress: onToolProgress });
    service = await startProductionServer({
      resourcesPath: process.resourcesPath,
      logsPath: app.getPath("logs"),
      url: SERVER_URL,
      signal: startup.signal,
      toolsetsRoot: toolsRoot,
      toolsetsBase,
      onToolProgress,
      onUnexpectedExit: (error) => showError(error.message),
    });
  }
  if (!quitting) {
    await window.loadURL(SERVER_URL);
    // 页面就绪后再启动后台检查，不阻塞首屏；缺少配置时保持静默。
    void initializeUpdates({ app, publish: (state) => {
      if (mainWindow && !mainWindow.isDestroyed() && isAppUrl(mainWindow.webContents.getURL())) mainWindow.webContents.send(UPDATE_CHANNELS.state, state);
    } }).then((service) => {
      if (quitting) service?.stop();
      else { updates = service; updates?.start(); }
    }).catch((error) => console.error("[desktop-update]", error.message));
  }
}).catch((error) => {
  if (!quitting) showError(error.message);
});
