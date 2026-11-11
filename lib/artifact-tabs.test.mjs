import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { artifactTabsReducer: reduce, initialArtifactTabs: initial } = await jiti.import("./artifact-tabs.ts");
const { draftPathKey } = await jiti.import("./file-draft.ts");
const file = (path = "/project/demo.md") => ({ id: `file:${path}`, kind: "file", label: "demo.md", filePath: path });
const open = (state, tab) => reduce(state, { type: "open", tab });

test("home is unique, launch replaces only home, and all content types share one strip", () => {
  let state = open(initial, { id: "files", kind: "files" });
  state = open(state, file());
  state = open(state, { id: "home", kind: "home" });
  state = open(state, { id: "home", kind: "home" });
  assert.deepEqual(state.tabs.map((tab) => tab.kind), ["files", "file", "home"]);
  state = open(state, { id: "changes", kind: "changes" });
  assert.deepEqual(state.tabs.map((tab) => tab.kind), ["files", "file", "changes"]);
  assert.equal(state.activeId, "changes");
  state = open(state, { id: "home", kind: "home" });
  state = open(state, file());
  assert.deepEqual(state.tabs.map((tab) => tab.kind), ["files", "file", "changes"]);
  assert.equal(state.activeId, file().id);
});

test("reopening a file preserves its authorization and accepts explicit Git Diff requests", () => {
  let state = open(initial, { ...file(), sourceSessionId: "origin" });
  state = open(state, file());
  assert.equal(state.tabs.length, 1);
  assert.equal(state.tabs[0].sourceSessionId, "origin");
  state = open(state, { ...file(), initialDisplayMode: "diff", diffRequest: 1 });
  state = open(state, { ...file(), initialDisplayMode: "diff", diffRequest: 2 });
  assert.equal(state.tabs[0].sourceSessionId, "origin");
  assert.equal(state.tabs[0].diffRequest, 2);
});

test("closing selects a neighbor and the final close restores home", () => {
  let state = open(open(initial, file()), { id: "changes", kind: "changes" });
  state = reduce(state, { type: "select", id: file().id });
  state = reduce(state, { type: "close", id: "changes" });
  assert.equal(state.activeId, file().id);
  state = reduce(state, { type: "close", id: file().id });
  assert.deepEqual(state, initial);
});

test("Windows file aliases reuse the same tab without changing its mounted path", () => {
  const path = "D:/Project/Notes.md";
  const alias = "d:\\project\\notes.md";
  const makeTab = (filePath) => ({ ...file(filePath), id: `file:${draftPathKey(filePath)}` });
  const state = open(open(initial, makeTab(path)), makeTab(alias));
  assert.equal(state.tabs.length, 1);
  assert.equal(state.tabs[0].filePath, path);
  assert.equal(state.activeId, `file:${draftPathKey(path)}`);
});

test("project reset discards all tabs without a persisted compatibility model", () => {
  const state = open(open(initial, file()), { id: "changes", kind: "changes" });
  assert.deepEqual(reduce(state, { type: "reset" }), initial);
});
