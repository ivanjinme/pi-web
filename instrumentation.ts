export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { configureHttpDispatcher } = await import("@/lib/http-dispatcher");
  configureHttpDispatcher();

  if (process.env.NODE_ENV === "production" && process.env.WECLIO_DESKTOP_UPDATE_IPC === "1" && process.send && process.connected) {
    const { registerDesktopUpdateGate } = await import("@/lib/desktop-update-gate");
    const { hasBusyDesktopTasks } = await import("@/lib/rpc-manager");
    registerDesktopUpdateGate(hasBusyDesktopTasks);
  }
}
