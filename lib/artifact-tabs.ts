export type ArtifactTab =
  | { id: "home"; kind: "home" }
  | { id: "files"; kind: "files" }
  | { id: "changes"; kind: "changes" }
  | {
      id: string;
      kind: "file";
      label: string;
      filePath: string;
      sourceSessionId?: string | null;
      initialDisplayMode?: "diff";
      diffRequest?: number;
    };

export interface ArtifactTabsState {
  tabs: ArtifactTab[];
  activeId: string;
}

export const initialArtifactTabs: ArtifactTabsState = {
  tabs: [{ id: "home", kind: "home" }],
  activeId: "home",
};

export type ArtifactTabsAction =
  | { type: "open"; tab: ArtifactTab }
  | { type: "select"; id: string }
  | { type: "close"; id: string }
  | { type: "reset" };

export function artifactTabsReducer(state: ArtifactTabsState, action: ArtifactTabsAction): ArtifactTabsState {
  switch (action.type) {
    case "reset":
      return initialArtifactTabs;
    case "select":
      return { ...state, activeId: action.id };
    case "open": {
      const existing = state.tabs.find((tab) => tab.id === action.tab.id);
      const opened = existing?.kind === "file" && action.tab.kind === "file"
        ? { ...existing, ...action.tab, filePath: existing.filePath }
        : action.tab;
      const tabs = opened.kind === "home" ? state.tabs : state.tabs.filter((tab) => tab.kind !== "home");
      return {
        tabs: existing ? tabs.map((tab) => tab.id === opened.id ? opened : tab) : [...tabs, opened],
        activeId: opened.id,
      };
    }
    case "close": {
      const index = state.tabs.findIndex((tab) => tab.id === action.id);
      const tabs = state.tabs.filter((tab) => tab.id !== action.id);
      if (tabs.length === 0) return initialArtifactTabs;
      return {
        tabs,
        activeId: state.activeId === action.id ? tabs[Math.min(index, tabs.length - 1)].id : state.activeId,
      };
    }
  }
}
