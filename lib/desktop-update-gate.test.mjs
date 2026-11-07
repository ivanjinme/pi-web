import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

let generate = async () => ({ title: "title" });
const jiti = createJiti(import.meta.url, {
  virtualModules: { "./session-title": { generateSessionTitle: (...args) => generate(...args) } },
});
const { beginDesktopTask, desktopUpdateStatus, unlockDesktopUpdate } = await jiti.import("./desktop-update-gate.ts");
const { AgentSessionWrapper, hasBusyDesktopTasks, autoNameRpcSession, startRpcSession } = await jiti.import("./rpc-manager.ts");
const status = (lock = true) => desktopUpdateStatus(lock, hasBusyDesktopTasks);
const turn = () => new Promise((resolve) => setImmediate(resolve));

function fixture(t) {
  unlockDesktopUpdate();
  const inner = {
    sessionId: "gate-fixture", isStreaming: false, isCompacting: false, isBashRunning: false,
    agent: { state: {} },
    sessionManager: { getSessionFile: () => undefined, getEntries: () => [] },
    extensionRunner: { emit: async () => {} },
    subscribe: () => () => {}, dispose() {},
    prompt: async () => {}, abort: async () => {}, abortBash() {}, abortCompaction() {},
    getAllTools: () => [], getActiveToolNames: () => [],
  };
  const session = new AgentSessionWrapper(inner, { bash: true, powershell: false });
  t.after(async () => { unlockDesktopUpdate(); await session.shutdown(); });
  return { inner, session };
}

test("pending admissions atomically reject a lock and locked gate rejects new work", () => {
  unlockDesktopUpdate();
  const finish = beginDesktopTask();
  assert.equal(status(), "busy");
  finish();
  assert.equal(status(false), "ready");
  const again = beginDesktopTask();
  again();
  assert.equal(status(), "ready");
  assert.throws(beginDesktopTask, /update in progress/);
  unlockDesktopUpdate();
  unlockDesktopUpdate();
});

test("prompt async tail blocks update after the send request has returned", async (t) => {
  const { inner, session } = fixture(t);
  const tail = Promise.withResolvers();
  inner.prompt = () => tail.promise;
  await session.send({ type: "prompt", message: "hello" });
  assert.equal(status(), "busy");
  tail.resolve();
  await turn();
  assert.equal(status(), "ready");
  await assert.rejects(session.send({ type: "prompt", message: "blocked" }), /update in progress/);
  await session.send({ type: "get_tools" });
  await session.send({ type: "abort" });
  await session.send({ type: "extension_ui_response", id: "unused" });
});

test("extension binding and prompt waiting on it count before their first await", async (t) => {
  const { inner, session } = fixture(t);
  const binding = Promise.withResolvers();
  inner.bindExtensions = () => binding.promise;
  session.beginExtensionBinding();
  const sending = session.send({ type: "prompt", message: "hello" });
  assert.equal(status(), "busy");
  binding.resolve();
  await sending;
  await turn();
  assert.equal(status(), "ready");
});

test("manual compaction, bash and awaited model commands hold pending reservations", async (t) => {
  for (const type of ["compact", "bash", "set_model"]) {
    const { inner, session } = fixture(t);
    const work = Promise.withResolvers();
    inner.compact = () => work.promise;
    inner.executeBash = () => work.promise;
    inner.modelRuntime = { getModel: () => ({ id: "model", provider: "fixture" }) };
    inner.setModel = () => work.promise;
    const sending = session.send({ type, command: "echo fixture" });
    assert.equal(status(), "busy");
    work.resolve();
    await sending;
    assert.equal(status(), "ready");
  }
});

test("title generation counts its readiness and provider await", async (t) => {
  const { session } = fixture(t);
  const work = Promise.withResolvers();
  generate = () => work.promise;
  const naming = autoNameRpcSession(session);
  assert.equal(status(), "busy");
  work.reject(new Error("provider failure"));
  await assert.rejects(naming, /provider failure/);
  assert.equal(status(), "ready");
});

test("existing SDK runtime flags, queued messages and startup registries block locking", (t) => {
  const { inner, session } = fixture(t);
  globalThis.__piSessions.set(inner.sessionId, session);
  t.after(() => globalThis.__piSessions.delete(inner.sessionId));
  for (const key of ["isStreaming", "isCompacting", "isBashRunning", "pendingMessageCount"]) {
    inner[key] = key === "pendingMessageCount" ? 1 : true;
    assert.equal(status(), "busy", key);
    inner[key] = key === "pendingMessageCount" ? 0 : false;
  }
  globalThis.__piStartLocks ??= new Map();
  globalThis.__piStartLocks.set("pending-start", Promise.resolve());
  assert.equal(status(), "busy");
  globalThis.__piStartLocks.delete("pending-start");
  assert.equal(status(), "ready");
});

test("locked gate rejects starting a new session before touching SDK services", async (t) => {
  fixture(t);
  assert.equal(status(), "ready");
  await assert.rejects(startRpcSession("not-created", "", process.cwd()), /update in progress/);
  assert.equal(globalThis.__piStartLocks?.size ?? 0, 0);
});
