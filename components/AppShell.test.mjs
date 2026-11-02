import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const explorerStart = source.indexOf('<div className="right-explorer-tree"');
const explorerEnd = source.indexOf("</section>", explorerStart);
const explorerSource = source.slice(explorerStart, explorerEnd);
const selectSessionStart = source.indexOf("const handleSelectSession = useCallback");
const selectSessionEnd = source.indexOf("const handleNewSession = useCallback", selectSessionStart);
const selectSessionSource = source.slice(selectSessionStart, selectSessionEnd);
const selectDraftProjectStart = source.indexOf("const handleDraftProjectSelect = useCallback");
const selectDraftProjectEnd = source.indexOf("const handleDraftProjectClear = useCallback", selectDraftProjectStart);
const selectDraftProjectSource = source.slice(selectDraftProjectStart, selectDraftProjectEnd);
const clearDraftProjectStart = selectDraftProjectEnd;
const clearDraftProjectEnd = source.indexOf("const resolveDefaultWorkspace = useCallback", clearDraftProjectStart);
const clearDraftProjectSource = source.slice(clearDraftProjectStart, clearDraftProjectEnd);

test("sidebar collapse lives in the sidebar while the chat opener only appears when closed", async () => {
  const sidebarSource = await readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(source, /<SessionSidebar[\s\S]*?onToggleSidebar=\{handleSidebarToggle\}/);
  assert.match(source, /\{!sidebarOpen && \(\s*<button[\s\S]*?onClick=\{handleSidebarToggle\}[\s\S]*?aria-label=\{translate\("sidebar.show"\)\}/);
  assert.doesNotMatch(source, /translate\("sidebar.hide"\)/);
  assert.match(sidebarSource, /className="session-sidebar-header-row"[\s\S]*?<PiWebTitle \/>[\s\S]*?className="sidebar-collapse-button"\s*onClick=\{onToggleSidebar\}\s*aria-label=\{t\("sidebar.hide"\)\}/);
  assert.match(sidebarSource, /: "Weclio";\s*const display = useScramble/);
  assert.match(styles, /\.session-sidebar-header-row > \.session-sidebar-brand\s*\{[^}]*font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;[^}]*font-weight: 500;/);
  assert.match(styles, /\.session-sidebar-brand\s*\{\s*height: 36px;/);
  assert.doesNotMatch(styles, /\.session-sidebar-header-row > button\s*\{/);
  assert.match(styles, /\.sidebar-collapse-button:focus-visible\s*\{/);
  assert.match(styles, /--app-top-bar-offset: 4px;/);
  assert.match(styles, /\.session-sidebar-header\s*\{\s*padding: var\(--app-top-bar-offset\) 10px 15px;/);
  assert.match(source, /ref=\{topBarRef\}[^\n]*marginTop: "var\(--app-top-bar-offset\)"/);
  assert.match(source, /position: "fixed", top: "var\(--app-window-toggle-top, var\(--app-top-bar-offset\)\)", right: "var\(--app-window-controls-inset, 0px\)"/);
  const headerRow = styles.match(/^\.session-sidebar-header-row\s*\{([^}]*)\}/m)?.[1];
  const collapseButton = styles.match(/^\.sidebar-collapse-button\s*\{([^}]*)\}/m)?.[1];
  assert.ok(headerRow);
  assert.ok(collapseButton);
  assert.match(headerRow, /display: flex;\s*align-items: center;/);
  assert.match(headerRow, /height: 36px;/);
  assert.match(headerRow, /margin-bottom: 24px;/);
  assert.match(collapseButton, /width: 36px;\s*height: 36px;/);
  assert.doesNotMatch(collapseButton, /position:|\btop:|transform:/);
});

test("desktop titlebar layout uses overlay geometry while Web retains its original dimensions", async () => {
  const styles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  const tabs = await readFile(new URL("./TabBar.tsx", import.meta.url), "utf8");
  assert.match(source, /useLayoutEffect\(bindWindowControlsOverlay, \[\]\)/);
  assert.match(source, /height: "var\(--app-titlebar-height, 36px\)"/);
  assert.match(source, /paddingRight: rightPanelOpen \? 0 : "var\(--app-window-controls-inset, 0px\)"/);
  assert.match(styles, /html\[data-window-controls-overlay\]:not\(\[data-native-fullscreen\]\)\s*\{[^}]*env\(titlebar-area-height, 40px\)/);
  assert.match(styles, /env\(titlebar-area-width, 100vw\)/);
  assert.match(styles, /--app-titlebar-button-height: min\(36px, var\(--app-titlebar-height\)\)/);
  assert.equal([...source.matchAll(/height: "var\(--app-titlebar-button-height, 36px\)"/g)].length, 2);
  assert.match(styles, /padding-right: calc\(36px \+ var\(--app-window-controls-inset\)\)/);
  assert.match(styles, /\.file-tab\)[\s\S]*?-webkit-app-region: no-drag;/);
  assert.match(tabs, /className="file-tab"/);
  assert.match(tabs, /height: "var\(--app-titlebar-height, 36px\)"/);
});

test("closing the right panel or collapsing Explorer keeps the file tree mounted", () => {
  assert.match(source, /\{activeCwd \? \(\s*<>\s*<section/);
  assert.doesNotMatch(source, /\{rightPanelOpen && activeCwd \? \(/);
  assert.match(explorerSource, /<div className="right-explorer-tree" hidden=\{rightExplorerCollapsed\}>/);
  assert.match(explorerSource, /<FileExplorer[\s\S]*?selectedFilePath=\{activeFileTab\?\.filePath\}[\s\S]*?onChangesCountChange=\{setRightChangesCount\}/);
  assert.doesNotMatch(explorerSource, /\{!rightExplorerCollapsed && \(\s*<div className="right-explorer-tree"/);
});

test("cross-project navigation clears open file artifacts", () => {
  assert.match(selectSessionSource, /const nextProject = session\.projectRoot \?\? session\.cwd;/);
  assert.match(selectSessionSource, /if \(currentProject && currentProject !== nextProject\) \{\s*setFileTabs\(\[\]\);\s*setActiveFileTabId\(null\);\s*\}/);
  assert.ok(
    selectSessionSource.indexOf("setFileTabs([])") < selectSessionSource.indexOf("activeProjectRootRef.current = nextProject"),
  );

  assert.match(selectDraftProjectSource, /if \(currentProject && currentProject !== cwd\) \{\s*setFileTabs\(\[\]\);\s*setActiveFileTabId\(null\);\s*\}/);
  assert.match(clearDraftProjectSource, /setFileTabs\(\[\]\);\s*setActiveFileTabId\(null\);/);
});
