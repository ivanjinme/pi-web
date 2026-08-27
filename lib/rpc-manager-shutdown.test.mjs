import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");

function wrapperFor(inner) {
  return new AgentSessionWrapper(inner);
}

function lifecycleInner(overrides = {}) {
  return {
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    autoCompactionEnabled: true,
    autoRetryEnabled: true,
    model: undefined,
    agent: { state: {} },
    extensionRunner: { async emit() {} },
    subscribe() { return () => {}; },
    abort: async () => {},
    abortBash() {},
    abortCompaction() {},
    dispose() {},
    getContextUsage: () => undefined,
    getSteeringMessages: () => [],
    getFollowUpMessages: () => [],
    pendingMessageCount: 0,
    ...overrides,
  };
}

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

test("shutdown notifies extensions before disposing and is idempotent", async () => {
  const calls = [];
  const wrapper = wrapperFor({
    isBashRunning: false,
    extensionRunner: { async emit(event) { calls.push(["emit", event]); } },
    dispose() { calls.push(["dispose"]); },
  });
  wrapper.onDestroy(() => calls.push(["destroy"]));

  await Promise.all([wrapper.shutdown(), wrapper.shutdown()]);

  assert.deepEqual(calls, [
    ["emit", { type: "session_shutdown", reason: "quit" }],
    ["dispose"],
    ["destroy"],
  ]);
  assert.equal(wrapper.isAlive(), false);
});

test("shutdown disposes even when an extension hook fails", async () => {
  const calls = [];
  const wrapper = wrapperFor({
    isBashRunning: false,
    extensionRunner: { async emit() { calls.push("emit"); throw new Error("shutdown hook failed"); } },
    dispose() { calls.push("dispose"); },
  });

  await assert.rejects(wrapper.shutdown(), /shutdown hook failed/);
  assert.deepEqual(calls, ["emit", "dispose"]);
  assert.equal(wrapper.isAlive(), false);
});

test("get_state polling does not keep an idle session alive", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let disposed = 0;
  const wrapper = wrapperFor(lifecycleInner({ dispose() { disposed += 1; } }));
  wrapper.start();

  t.mock.timers.tick(9 * 60 * 1000);
  await wrapper.send({ type: "get_state" });
  t.mock.timers.tick(60 * 1000);
  await nextTurn();

  assert.equal(disposed, 1);
  assert.equal(wrapper.isAlive(), false);
});

test("active sessions survive idle cleanup until Stop gets stuck", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let disposed = 0;
  let listener;
  let resolveAbort;
  const inner = lifecycleInner({
    isStreaming: true,
    subscribe(fn) { listener = fn; return () => {}; },
    abort: () => new Promise((resolve) => { resolveAbort = resolve; }),
    dispose() { disposed += 1; },
  });
  const wrapper = wrapperFor(inner);
  wrapper.start();

  t.mock.timers.tick(10 * 60 * 1000);
  await nextTurn();
  assert.equal(disposed, 0);

  const stopping = wrapper.send({ type: "abort" });
  t.mock.timers.tick(5 * 60 * 1000);
  listener({ type: "message_update" });
  t.mock.timers.tick(5 * 60 * 1000);
  await nextTurn();
  assert.equal(disposed, 1);
  assert.equal(wrapper.isAlive(), false);

  resolveAbort();
  await stopping;
});

test("a stuck bash process is reclaimed after abort_bash", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let disposed = 0;
  const wrapper = wrapperFor(lifecycleInner({
    isBashRunning: true,
    dispose() { disposed += 1; },
  }));
  wrapper.start();

  await wrapper.send({ type: "abort_bash" });
  t.mock.timers.tick(10 * 60 * 1000);
  await nextTurn();

  assert.equal(disposed, 1);
  assert.equal(wrapper.isAlive(), false);
});

test("direct destruction emits session_shutdown before dispose", async () => {
  const calls = [];
  const wrapper = wrapperFor({
    isBashRunning: false,
    extensionRunner: { async emit(event) { calls.push(["emit", event]); } },
    dispose() { calls.push(["dispose"]); },
  });
  wrapper.onDestroy(() => calls.push(["destroy"]));

  wrapper.destroy();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(calls, [
    ["emit", { type: "session_shutdown", reason: "quit" }],
    ["dispose"],
    ["destroy"],
  ]);
  assert.equal(wrapper.isAlive(), false);
});
