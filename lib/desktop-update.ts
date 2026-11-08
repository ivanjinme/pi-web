import type { Locale } from "@/lib/i18n/types";

export interface DesktopUpdateState {
  status: "idle" | "checking" | "downloading" | "preparing" | "downloaded" | "error";
  version?: string;
  kind?: "application";
  phase?: "download" | "extracting" | "verifying";
  progress?: number;
}

export interface DesktopUpdateBridge {
  getUpdateState(): Promise<DesktopUpdateState>;
  onUpdateState(listener: (state: DesktopUpdateState) => void): () => void;
  restartUpdate(locale: Locale): Promise<void>;
  applicationReady?(): Promise<void>;
  checkForUpdates?(): Promise<void>;
}

declare global {
  interface Window {
    weclioDesktop?: DesktopUpdateBridge;
  }
}
