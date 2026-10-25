import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { visibleThreadRoots, threadTitleIds, sessionDisplayTitle } = await jiti.import("./sidebar-session-list.ts");

test("named session search uses the displayed title, not the original prompt or cwd", () => {
  const session = { name: "Login fix", firstMessage: "original prompt", cwd: "/project-path" };
  const title = sessionDisplayTitle(session).toLowerCase();
  assert.equal(title, "login fix");
  assert.ok(title.includes("login"));
  assert.ok(!title.includes("original"));
  assert.ok(!title.includes("project-path"));
});

test("unnamed session search uses only its displayed 50-character fallback", () => {
  const firstMessage = "visible summary " + "x".repeat(50) + " hidden-tail";
  const title = sessionDisplayTitle({ firstMessage });
  assert.equal(title, firstMessage.slice(0, 50));
  assert.ok(title.includes("visible summary"));
  assert.ok(!title.includes("hidden-tail"));
  assert.equal(sessionDisplayTitle({ name: "", firstMessage }), title);
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
