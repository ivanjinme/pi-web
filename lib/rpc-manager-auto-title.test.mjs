import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

let generate;
let calls = 0;
const jiti = createJiti(import.meta.url, {
  virtualModules: {
    "./session-title": { generateSessionTitle: (...args) => { calls++; return generate(...args); } },
  },
});
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

function fixture(t, isNew = true) {
  calls = 0;
  generate = async () => ({ title: "Generated title" });
  const entries = [];
  const names = [];
  let listener;
  let stopReason = "stop";
  const inner = {
    sessionId: "new-title",
    sessionManager: { getSessionFile: () => undefined, getEntries: () => entries },
    agent: { state: {} },
    isStreaming: false, isCompacting: false, isBashRunning: false,
    subscribe: (callback) => { listener = callback; return () => {}; },
    prompt: async () => { listener({ type: "message_end", message: { role: "assistant", stopReason } }); },
    setSessionName: (name) => { entries.push({ type: "session_info", name }); names.push(name); },
    extensionRunner: { async emit() {} },
    dispose() {},
  };
  const session = new AgentSessionWrapper(inner, { bash: true, powershell: false }, isNew);
  session.start();
  t.after(() => session.shutdown());
  const prompt = async (reason = "stop") => {
    stopReason = reason;
    await session.send({ type: "prompt", message: "hello" });
    await nextTurn();
  };
  return { inner, names, prompt, session };
}

test("new session gets one background title after its first successful response", async (t) => {
  const { names, prompt } = fixture(t);
  await prompt();
  assert.deepEqual(names, ["Generated title"]);
  await prompt();
  assert.equal(calls, 1);
});

test("failed and aborted responses do not trigger naming; the first success does", async (t) => {
  const { prompt, names } = fixture(t);
  await prompt("error");
  await prompt("aborted");
  assert.equal(calls, 0);
  await prompt();
  assert.deepEqual(names, ["Generated title"]);
});

test("existing sessions and manually named new sessions are not automatically renamed", async (t) => {
  const existing = fixture(t, false);
  await existing.prompt();
  assert.equal(calls, 0);
  const fresh = fixture(t);
  fresh.inner.setSessionName("Manual title");
  await fresh.prompt();
  assert.equal(calls, 0);
  assert.deepEqual(fresh.names, ["Manual title"]);
});

test("manual rename or explicit clear during generation wins", async (t) => {
  for (const manual of ["Manual title", ""]) {
    const { session, prompt, names } = fixture(t);
    const gate = Promise.withResolvers();
    generate = () => gate.promise;
    await prompt();
    assert.equal(calls, 1);
    await session.send({ type: "set_session_name", name: manual });
    gate.resolve({ title: "Too late" });
    await nextTurn();
    assert.deepEqual(names, [manual]);
  }
});

test("explicit whitespace clear before the first reply prevents auto naming", async (t) => {
  const { session, prompt, names } = fixture(t);
  await session.send({ type: "set_session_name", name: "   " });
  await prompt();
  assert.equal(calls, 0);
  assert.deepEqual(names, [""]);
});

test("title generation does not block prompting, and failures are not retried", async (t) => {
  const warnings = [];
  t.mock.method(console, "warn", (...args) => warnings.push(args));
  const { prompt, names } = fixture(t);
  const gate = Promise.withResolvers();
  generate = () => gate.promise;
  await prompt();
  assert.equal(calls, 1);
  assert.deepEqual(names, []);
  gate.reject(new Error("provider failed"));
  await nextTurn();
  await prompt();
  assert.equal(calls, 1);
  assert.equal(warnings.length, 1);
  assert.deepEqual(names, []);
});

test("closing the session during generation does not save a title", async (t) => {
  const { prompt, names, session } = fixture(t);
  const gate = Promise.withResolvers();
  generate = () => gate.promise;
  await prompt();
  await session.shutdown();
  gate.resolve({ title: "Too late" });
  await nextTurn();
  assert.deepEqual(names, []);
});
