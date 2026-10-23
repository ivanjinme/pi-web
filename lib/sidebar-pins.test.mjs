import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const { readSidebarPins, setSidebarPin, rebindPinnedProject } = await createJiti(import.meta.url).import("./sidebar-pins.ts");

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "sidebar-pins-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, "sidebar.json");
}

const project = { type: "project", id: "D:/work/project" };
const session = { type: "session", id: "session-1" };

test("stores mixed project and session references in one ordered file", (t) => {
  const file = fixture(t);
  assert.deepEqual(readSidebarPins(file), []);
  setSidebarPin(project, true, file);
  setSidebarPin(session, true, file);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { version: 1, pins: [project, session] });
  assert.deepEqual(readSidebarPins(file), [project, session]);
  assert.deepEqual(readdirSync(join(file, "..")), ["sidebar.json"]);
});

test("set and unset are idempotent and distinguish project paths from session IDs", (t) => {
  const file = fixture(t);
  setSidebarPin(project, true, file);
  setSidebarPin({ type: "project", id: "d:\\WORK\\project\\" }, true, file);
  setSidebarPin({ type: "session", id: project.id }, true, file);
  assert.equal(readSidebarPins(file).length, 2);
  setSidebarPin({ type: "project", id: "d:/WORK/project" }, false, file);
  setSidebarPin(project, false, file);
  assert.deepEqual(readSidebarPins(file), [{ type: "session", id: project.id }]);
});

test("unpinning an absent item does not create a persistence file", (t) => {
  const file = fixture(t);
  assert.deepEqual(setSidebarPin(session, false, file), []);
  assert.equal(existsSync(file), false);
});

test("mutations read current disk state instead of overwriting other clients", (t) => {
  const file = fixture(t);
  setSidebarPin(project, true, file);
  readSidebarPins(file);
  setSidebarPin(session, true, file);
  assert.deepEqual(setSidebarPin(project, false, file), [session]);
});

test("project rebind preserves order and deduplicates the destination", (t) => {
  const file = fixture(t);
  setSidebarPin(project, true, file);
  setSidebarPin(session, true, file);
  setSidebarPin({ type: "project", id: "/new/root" }, true, file);
  rebindPinnedProject("d:/WORK/project", "/new/root", file);
  assert.deepEqual(readSidebarPins(file), [{ type: "project", id: "/new/root" }, session]);
  rebindPinnedProject("/missing", "/unrelated", file);
  assert.equal(readSidebarPins(file).length, 2);
});

test("invalid existing data is reported instead of silently replaced", (t) => {
  const file = fixture(t);
  writeFileSync(file, "broken json");
  assert.throws(() => setSidebarPin(session, true, file), SyntaxError);
  assert.equal(readFileSync(file, "utf8"), "broken json");
});
