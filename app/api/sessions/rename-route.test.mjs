import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

let live;
let appended;
let invalidations;
const jiti = createJiti(import.meta.url, {
  virtualModules: {
    "@earendil-works/pi-coding-agent": {
      SessionManager: { open: () => ({ appendSessionInfo: (name) => appended.push(name) }) },
    },
    "@/lib/session-reader": {
      resolveSessionPath: async () => "session.jsonl",
      invalidateSessionListCache: () => invalidations++,
    },
    "@/lib/rpc-manager": { getRpcSession: () => live },
    "@/lib/sidebar-pins": { setSidebarPin() {} },
    "@/lib/session-path": { sessionPathKey: (path) => path },
  },
});
const { PATCH } = await jiti.import("./[id]/route.ts");
const { AgentSessionWrapper } = await createJiti(import.meta.url).import("../../../lib/rpc-manager.ts");
const request = (name) => PATCH(new Request("http://localhost/api/sessions/id", {
  method: "PATCH", body: JSON.stringify({ name }),
}), { params: Promise.resolve({ id: "id" }) });

test("manual rename goes through the live manager so pending auto-naming observes it", async () => {
  appended = [];
  invalidations = 0;
  const commands = [];
  live = { isAlive: () => true, send: async (command) => commands.push(command) };
  assert.equal((await request(" Manual ")).status, 200);
  assert.deepEqual(commands, [{ type: "set_session_name", name: "Manual" }]);
  assert.deepEqual(appended, []);
});

test("live PATCH clears empty and whitespace names through the real wrapper", async (t) => {
  const entries = [];
  live = new AgentSessionWrapper({
    sessionId: "id",
    sessionManager: { getEntries: () => entries },
    setSessionName: (name) => entries.push({ type: "session_info", name }),
    extensionRunner: { async emit() {} },
    dispose() {},
  }, { bash: true, powershell: false });
  t.after(() => live.shutdown());
  for (const name of ["", "   "]) {
    assert.equal((await request(name)).status, 200);
  }
  assert.deepEqual(entries, [{ type: "session_info", name: "" }, { type: "session_info", name: "" }]);
});

test("inactive session rename appends metadata and invalidates the catalog", async () => {
  live = undefined;
  appended = [];
  invalidations = 0;
  assert.equal((await request("")).status, 200);
  assert.deepEqual(appended, [""]);
  assert.equal(invalidations, 1);
});
