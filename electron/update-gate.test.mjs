import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createUpdateGate } from "./update-gate.mjs";

function fixture(t) {
  const child = Object.assign(new EventEmitter(), { connected: true, sent: [] });
  child.send = (message, callback) => { child.sent.push(message); callback?.(); };
  const gate = createUpdateGate(child);
  t.after(() => gate.dispose());
  const reply = (status = "ready", request = child.sent.at(-1)) => child.emit("message", { type: "weclio-desktop-update-result", id: request.id, status });
  return { child, gate, reply };
}

test("one owned channel correlates replies and supports inspect/lock/idempotent unlock", async (t) => {
  const { child, gate, reply } = fixture(t);
  for (const action of ["inspect", "lock", "unlock", "unlock"]) {
    const result = gate[action]();
    assert.equal(child.sent.at(-1).action, action);
    reply(action === "inspect" ? "busy" : "ready");
    assert.equal(await result, action === "unlock" ? undefined : action === "inspect" ? "busy" : "ready");
  }
  gate.dispose();
  for (const name of ["message", "error", "disconnect", "exit"]) assert.equal(child.listenerCount(name), 0);
});

test("malformed matching replies reject; unrelated traffic is ignored", async (t) => {
  const { child, gate, reply } = fixture(t);
  const result = gate.lock();
  child.emit("message", { id: "other", status: "ready" });
  reply("invalid");
  await assert.rejects(result, /Malformed/);
  assert.equal(child.sent.at(-1).action, "unlock");
});

test("lock timeout orders an unlock after the lock and ignores late reply", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { child, gate, reply } = fixture(t);
  const result = gate.lock();
  const lock = child.sent[0];
  const rejected = assert.rejects(result, /timed out/);
  t.mock.timers.tick(5_000);
  assert.deepEqual(child.sent.map((m) => m.action), ["lock", "unlock"]);
  reply("ready", lock);
  await rejected;
});

test("IPC errors, disconnect and exit reject pending work and remove listeners", async (t) => {
  for (const event of ["error", "disconnect", "exit"]) {
    const { child, gate } = fixture(t);
    const a = gate.inspect();
    const b = gate.lock();
    const rejected = Promise.all([assert.rejects(a), assert.rejects(b)]);
    child.emit(event, new Error("fixture failure"));
    await rejected;
    await assert.rejects(gate.inspect());
    assert.equal(child.listenerCount("message"), 0);
  }
});

test("send callback errors and synchronous throws reject safely", async (t) => {
  for (const throwing of [false, true]) {
    const { child, gate } = fixture(t);
    child.send = (_message, cb) => {
      if (throwing) throw new Error("send failed");
      cb(new Error("send failed"));
    };
    await assert.rejects(gate.lock(), /send failed/);
  }
});

test("pending request map is bounded and dispose clears every timer", async (t) => {
  const { gate } = fixture(t);
  const requests = Array.from({ length: 32 }, () => assert.rejects(gate.inspect(), /disposed/));
  await assert.rejects(gate.inspect(), /Too many/);
  gate.dispose();
  await Promise.all(requests);
});
