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

test("closing the right panel or collapsing Explorer keeps the file tree mounted", () => {
  assert.match(source, /\{activeCwd \? \(\s*<>\s*<section/);
  assert.doesNotMatch(source, /\{rightPanelOpen && activeCwd \? \(/);
  assert.match(explorerSource, /<div className="right-explorer-tree" hidden=\{rightExplorerCollapsed\}>/);
  assert.match(explorerSource, /<FileExplorer[\s\S]*?onChangesCountChange=\{setRightChangesCount\}/);
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
