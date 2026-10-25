import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { visibleThreadRoots, threadTitleIds, needsSessionTitle, applySessionTitle } = await jiti.import("./sidebar-session-list.ts");

test("search upgrades loaded titles and lightweight responses preserve full search text", () => {
  for (const name of ["Manual title", undefined]) {
    const session = { id: "thread", name, firstMessage: "", titleLoaded: false };
    const title = applySessionTitle(session, { name, firstMessage: name ? "" : "short prefix" }, false);
    assert.equal(needsSessionTitle(title, false), false);
    assert.equal(needsSessionTitle(title, true), true);
    const full = "original-prompt " + "x".repeat(60) + " beyond-fifty";
    const searchable = applySessionTitle(title, { name, firstMessage: full }, true);
    assert.equal(needsSessionTitle(searchable, true), false);
    assert.ok(searchable.firstMessage.includes("original-prompt"));
    assert.ok(searchable.firstMessage.includes("beyond-fifty"));
    const refreshed = applySessionTitle(searchable, { name, firstMessage: "short prefix" }, false);
    assert.equal(refreshed.firstMessage, full);
    assert.equal(refreshed.firstMessageLoaded, true);
    assert.equal(needsSessionTitle({ ...session, modified: "new revision" }, true), true);
  }
});

function group() {
  const roots = Array.from({ length: 20 }, (_, index) => ({ session: { id: `root-${index}` }, children: [] }));
  const child = { session: { id: "child", parentSessionId: "root-19" }, children: [] };
  roots[19].children.push(child);
  return { roots, sessions: [...roots.map((node) => node.session), child.session] };
}

test("only the first five root titles are requested initially; Show more adds ten", () => {
  const data = group();
  assert.deepEqual(threadTitleIds(visibleThreadRoots(data, 5, null)).sort(), ["root-0", "root-1", "root-2", "root-3", "root-4"]);
  assert.equal(threadTitleIds(visibleThreadRoots(data, 15, null)).length, 15);
});

test("selected threads outside the first page retain their root and descendants", () => {
  const data = group();
  const visible = visibleThreadRoots(data, 5, "child");
  assert.equal(visible.length, 5);
  assert.equal(visible[4].session.id, "root-19");
  assert.ok(threadTitleIds(visible).includes("child"));
  assert.ok(!threadTitleIds(visible).includes("root-4"));
});
