import assert from "node:assert/strict";
import { normalize, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createJiti } from "jiti";

// 只读对照实验：保留默认展开的子 thread 和服务端置顶，不读取浏览器本地隐藏状态。
export function selectVisible(sessions, pins = [], projectKey = (path) => path) {
  const pathToId = new Map(sessions.map((s) => [normalize(s.path), s.id]));
  const pinnedSessions = new Set(pins.filter((p) => p.type === "session").map((p) => p.id));
  const pinnedProjects = new Set(pins.filter((p) => p.type === "project").map((p) => projectKey(p.id)));
  const groups = new Map();
  for (const session of [...sessions].sort((a, b) => Number(b.modified) - Number(a.modified))) {
    if (!groups.has(session.projectRoot)) groups.set(session.projectRoot, []);
    groups.get(session.projectRoot).push(session);
  }
  const selected = new Map(sessions.filter((s) => pinnedSessions.has(s.id)).map((s) => [s.id, s]));
  let unpinnedProjects = 0;
  for (const [root, group] of groups) {
    if (!pinnedProjects.has(projectKey(root)) && ++unpinnedProjects > 5) continue;
    const unpinned = group.filter((s) => !pinnedSessions.has(s.id));
    const ids = new Set(unpinned.map((s) => s.id));
    const children = new Map();
    const roots = [];
    for (const session of unpinned) {
      const parentId = session.parentSession ? pathToId.get(normalize(session.parentSession)) : undefined;
      if (ids.has(parentId)) {
        if (!children.has(parentId)) children.set(parentId, []);
        children.get(parentId).push(session);
      } else roots.push(session);
    }
    const pending = roots.slice(0, 5);
    while (pending.length) {
      const session = pending.pop();
      if (selected.has(session.id)) continue;
      selected.set(session.id, session);
      pending.push(...(children.get(session.id) ?? []));
    }
  }
  return [...selected.values()];
}

async function main() {
  const started = performance.now();
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
  const sdkImportMs = Math.round(performance.now() - started);
  const jiti = createJiti(import.meta.url);
  const reader = await jiti.import("../lib/session-reader.ts");
  const { resolveProject, invalidateProjectCache } = await jiti.import("../lib/worktree.ts");
  const { readSidebarPins } = await jiti.import("../lib/sidebar-pins.ts");
  const { projectPathKey } = await jiti.import("../lib/project-folders.ts");
  const pins = readSidebarPins();
  let baseline;
  let catalog;
  let titles;

  async function fullScan() {
    invalidateProjectCache();
    const start = performance.now();
    baseline = await SessionManager.listAll();
    await Promise.all([...new Set(baseline.map((s) => s.cwd))].map(resolveProject));
    return Math.round(performance.now() - start);
  }

  async function selectiveScan() {
    invalidateProjectCache();
    reader.invalidateSessionListCache();
    let start = performance.now();
    catalog = await reader.listAllSessions();
    const catalogMs = Math.round(performance.now() - start);
    const byId = new Map(catalog.map((s) => [s.id, s]));
    const selected = selectVisible(catalog.map((s) => ({
      ...s, modified: Date.parse(s.modified),
      parentSession: s.parentSessionId ? byId.get(s.parentSessionId)?.path : undefined,
    })), pins, projectPathKey);
    start = performance.now();
    titles = await reader.loadSessionTitles(selected.map((s) => s.id));
    return { catalogMs, titlesMs: Math.round(performance.now() - start) };
  }

  console.log(JSON.stringify({ sdkImportMs, note: "Catalog invalidated each round; OS cache not cleared; no transcript/title content logged." }));
  for (let round = 1; round <= 3; round++) {
    let fullScanMs;
    let selective;
    if (round % 2) { fullScanMs = await fullScan(); selective = await selectiveScan(); }
    else { selective = await selectiveScan(); fullScanMs = await fullScan(); }
    const baselineById = new Map(baseline.map((s) => [s.id, s]));
    assert.deepEqual(new Set(catalog.map((s) => s.id)), new Set(baselineById.keys()));
    for (const actual of titles) {
      const expected = baselineById.get(actual.id);
      assert.equal(actual.name || actual.firstMessage, expected.name || expected.firstMessage.slice(0, 50));
    }
    console.log(JSON.stringify({ round, fullScanMs, ...selective, catalogFiles: catalog.length, visibleTitles: titles.length, titlesMatch: true }));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
