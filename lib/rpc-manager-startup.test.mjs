import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import * as sdk from "@earendil-works/pi-coding-agent";

let createServices;
let createSession;

// 只替换 SDK 创建边界，测试真实 registry、启动锁和 wrapper 生命周期。
const jiti = createJiti(import.meta.url, {
  virtualModules: {
    "@earendil-works/pi-coding-agent": {
      ...sdk,
      initTheme() {},
      getShellConfig() {},
      getPowerShellConfig() {},
      SessionManager: { create: (cwd) => ({ getCwd: () => cwd }) },
      createAgentSessionServices: (...args) => createServices(...args),
      createAgentSessionFromServices: (...args) => createSession(...args),
    },
  },
});
const { startRpcSession, getRpcSession, hasBusyRpcSessionForCwd } = await jiti.import("./rpc-manager.ts");

function sessionInner(sessionId, sessionManager) {
  return {
    sessionId,
    sessionManager,
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    agent: { state: {} },
    subscribe: () => () => {},
    extensionRunner: { async emit() {} },
    dispose() {},
  };
}

test("concurrent starts share one runtime and track startup as busy", async (t) => {
  const gate = Promise.withResolvers();
  let serviceCalls = 0;
  let sessionCalls = 0;
  createServices = () => { serviceCalls += 1; return gate.promise; };
  createSession = async ({ sessionManager }) => {
    sessionCalls += 1;
    return { session: sessionInner("startup-shared", sessionManager) };
  };
  t.after(async () => { await getRpcSession("startup-shared")?.shutdown(); });

  const first = startRpcSession("startup-shared", "", process.cwd());
  const second = startRpcSession("startup-shared", "", process.cwd());
  assert.equal(serviceCalls, 1);
  assert.equal(hasBusyRpcSessionForCwd(process.cwd()), true);
  gate.resolve({});

  const [a, b] = await Promise.all([first, second]);
  assert.equal(sessionCalls, 1);
  assert.equal(a.session, b.session);
  assert.equal(getRpcSession("startup-shared"), a.session);
  assert.equal(hasBusyRpcSessionForCwd(process.cwd()), false);
  const reused = await startRpcSession("startup-shared", "", process.cwd());
  assert.equal(reused.session, a.session);
  assert.equal(serviceCalls, 1);
});

test("failed startup releases the shared lock and busy marker so retry can succeed", async (t) => {
  const gate = Promise.withResolvers();
  createServices = () => gate.promise;
  createSession = async ({ sessionManager }) => ({ session: sessionInner("startup-retry", sessionManager) });
  t.after(async () => { await getRpcSession("startup-retry")?.shutdown(); });

  const first = startRpcSession("startup-retry", "", process.cwd());
  const second = startRpcSession("startup-retry", "", process.cwd());
  const failures = Promise.all([
    assert.rejects(first, /startup failed/),
    assert.rejects(second, /startup failed/),
  ]);
  gate.reject(new Error("startup failed"));
  await failures;
  assert.equal(getRpcSession("startup-retry"), undefined);
  assert.equal(hasBusyRpcSessionForCwd(process.cwd()), false);

  createServices = async () => ({});
  const retried = await startRpcSession("startup-retry", "", process.cwd());
  assert.equal(getRpcSession("startup-retry"), retried.session);
});
