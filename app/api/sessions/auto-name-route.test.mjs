import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

let generateTitle;
let invalidations = 0;
const sessionReader = {
  resolveSessionPath: async () => "session.jsonl",
  invalidateSessionListCache: () => { invalidations += 1; },
};
// 保留真实 route 和 runtime 操作，只替换文件读取和模型调用。
const virtualModules = {
  "./session-title": { generateSessionTitle: (source) => generateTitle(source) },
  "./session-reader": sessionReader,
  "@/lib/session-reader": sessionReader,
};
const jiti = createJiti(import.meta.url, { virtualModules });
const { SessionManager } = await jiti.import("@earendil-works/pi-coding-agent");
const runtime = await jiti.import("../../../lib/rpc-manager.ts");
virtualModules["@/lib/rpc-manager"] = runtime;
const { AgentSessionWrapper } = runtime;
const { POST } = await jiti.import("./[id]/auto-name/route.ts");
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

function fixture(t, overrides = {}) {
  t.mock.method(SessionManager, "open", () => ({ getHeader: () => ({ cwd: "/project" }) }));
  invalidations = 0;
  const names = [];
  const inner = {
    sessionId: "auto-name",
    setSessionName: (name) => names.push(name),
    extensionRunner: { async emit() {} },
    dispose() {},
    ...overrides,
  };
  const session = new AgentSessionWrapper(inner, { bash: true, powershell: false });
  globalThis.__piSessions ??= new Map();
  globalThis.__piSessions.set("auto-name", session);
  t.after(async () => {
    globalThis.__piSessions.delete("auto-name");
    await session.shutdown();
  });
  const request = () => POST(new Request("http://localhost"), { params: Promise.resolve({ id: "auto-name" }) });
  return { session, inner, names, request };
}

test("auto-name waits for readiness, renames through runtime and invalidates the session list once", async (t) => {
  const binding = Promise.withResolvers();
  const { session, inner, names, request } = fixture(t, { bindExtensions: () => binding.promise });
  const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 };
  let generated = false;
  generateTitle = async (source) => {
    assert.equal(source, inner);
    generated = true;
    return { title: "Generated title", usage };
  };
  session.beginExtensionBinding();
  const response = request();
  await nextTurn();
  assert.equal(generated, false);
  binding.resolve();

  const result = await response;
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { title: "Generated title", usage });
  assert.deepEqual(names, ["Generated title"]);
  assert.equal(invalidations, 1);
});

test("auto-name does not rename a session closed during generation", async (t) => {
  const title = Promise.withResolvers();
  const { session, names, request } = fixture(t);
  generateTitle = () => title.promise;
  const response = request();
  await nextTurn();
  await session.shutdown();
  title.resolve({ title: "Too late" });

  const result = await response;
  assert.equal(result.status, 409);
  assert.deepEqual(names, []);
  assert.equal(invalidations, 0);
});

test("auto-name preserves generation failures without renaming", async (t) => {
  const { names, request } = fixture(t);
  generateTitle = async () => { throw new Error("provider failed"); };
  const result = await request();
  assert.equal(result.status, 500);
  assert.deepEqual(await result.json(), { error: "provider failed" });
  assert.deepEqual(names, []);
  assert.equal(invalidations, 0);
});

test("auto-name still accepts pre-readiness wrappers retained by hot reload", async (t) => {
  const { inner, names, request } = fixture(t);
  globalThis.__piSessions.set("auto-name", { inner, isAlive: () => true });
  generateTitle = async () => ({ title: "Existing session" });
  const result = await request();
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { title: "Existing session", usage: null });
  assert.deepEqual(names, ["Existing session"]);
  assert.equal(invalidations, 1);
});
