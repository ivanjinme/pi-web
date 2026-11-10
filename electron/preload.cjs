// Electron 沙盒预加载只支持 CommonJS，不能使用 ESM 导入。
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("weclioDesktop", Object.freeze({
  getUpdateState: () => ipcRenderer.invoke("desktop-update:get"),
  onUpdateState: (listener) => {
    const handler = (_event, state) => listener(state);
    ipcRenderer.on("desktop-update:state", handler);
    return () => ipcRenderer.removeListener("desktop-update:state", handler);
  },
  restartUpdate: (locale) => ipcRenderer.invoke("desktop-update:restart", locale),
  checkForUpdates: () => ipcRenderer.invoke("desktop-update:check"),
}));
