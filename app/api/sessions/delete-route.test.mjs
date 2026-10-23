import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const loader = createJiti(import.meta.url);
const pins = await loader.import("../../../lib/sidebar-pins.ts");
const sessionPath = await loader.import("../../../lib/session-path.ts");
let current;
// 保留真实 route、会话文件和置顶读写，仅隔离用户数据目录与运行实例。
const jiti = createJiti(import.meta.url, {
  virtualModules: {
    "@/lib/session-path": sessionPath,
    "@/lib/session-reader": {
      resolveSessionPath: async () => current.sessionPath,
      readSessionHeader: (file) => JSON.parse(readFileSync(file, "utf8").split("\n")[0]),
      invalidateSessionPathCache: (id) => current.invalidatedIds.push(id),
      invalidateSessionListCache: () => { current.listInvalidations += 1; },
    },
    "@/lib/rpc-manager": {
      getRpcSession: () => ({ destroy: () => { current.destroyed += 1; } }),
    },
    "@/lib/sidebar-pins": {
      setSidebarPin: (pin, pinned) => pins.setSidebarPin(pin, pinned, current.sidebarPath),
    },
  },
});
const { DELETE } = await jiti.import("./[id]/route.ts");

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "session-delete-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const sessionPath = join(directory, "session.jsonl");
  const parentPath = join(directory, "parent.jsonl");
  const childPath = join(directory, "child.jsonl");
  const sidebarPath = join(directory, "sidebar.json");
  writeFileSync(sessionPath, JSON.stringify({ type: "session", id: "target", parentSession: parentPath }) + "\n");
  const childSource = JSON.stringify({ type: "session", id: "child", parentSession: sessionPath }) + "\n";
  writeFileSync(childPath, childSource);
  pins.setSidebarPin({ type: "session", id: "target" }, true, sidebarPath);
  current = { sessionPath, sidebarPath, destroyed: 0, invalidatedIds: [], listInvalidations: 0 };
  const request = () => DELETE(new Request("http://localhost/api/sessions/target", { method: "DELETE" }), {
    params: Promise.resolve({ id: "target" }),
  });
  return { ...current, state: current, parentPath, childPath, childSource, request };
}

for (const failure of ["corrupt data", "write failure"]) {
  test(`deletion preserves the session, child linkage and runtime on pin ${failure}`, async (t) => {
    const f = fixture(t);
    if (failure === "corrupt data") {
      writeFileSync(f.sidebarPath, "broken json");
    } else {
      // 临时文件位置被目录占用，使真实置顶写入失败。
      mkdirSync(`${f.sidebarPath}.tmp`);
    }
    const sessionSource = readFileSync(f.sessionPath, "utf8");

    const response = await f.request();

    assert.equal(response.status, 500);
    assert.ok((await response.json()).error);
    assert.equal(readFileSync(f.sessionPath, "utf8"), sessionSource);
    assert.equal(readFileSync(f.childPath, "utf8"), f.childSource);
    assert.equal(f.state.destroyed, 0);
    assert.deepEqual(f.state.invalidatedIds, []);
    assert.equal(f.state.listInvalidations, 0);
  });
}

test("successful deletion clears the pin, reparents children and invalidates caches", async (t) => {
  const f = fixture(t);

  const response = await f.request();

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(existsSync(f.sessionPath), false);
  assert.deepEqual(pins.readSidebarPins(f.sidebarPath), []);
  assert.equal(JSON.parse(readFileSync(f.childPath, "utf8")).parentSession, f.parentPath);
  assert.equal(f.state.destroyed, 1);
  assert.deepEqual(f.state.invalidatedIds, ["target"]);
  assert.equal(f.state.listInvalidations, 1);
});

test("missing sessions return 404 without changing pins or runtime", async (t) => {
  const f = fixture(t);
  f.state.sessionPath = null;

  const response = await f.request();

  assert.equal(response.status, 404);
  assert.deepEqual(pins.readSidebarPins(f.sidebarPath), [{ type: "session", id: "target" }]);
  assert.equal(f.state.destroyed, 0);
  assert.deepEqual(f.state.invalidatedIds, []);
  assert.equal(f.state.listInvalidations, 0);
});
