import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");

function wrapperFor(inner) {
  return new AgentSessionWrapper(inner);
}

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
