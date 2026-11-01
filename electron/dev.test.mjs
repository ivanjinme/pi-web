import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

const mocks = {
  "node:child_process": `
    import { EventEmitter } from 'node:events';
    export const calls = [];
    export function spawn(command, args, options) {
      calls.push({ command, args, options });
      return Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(), stderr: new EventEmitter(),
        exitCode: null, signalCode: null
      });
    }
    export function spawnSync() { throw new Error('Unexpected process termination'); }
  `,
  electron: "export default 'test-electron.exe';",
  "node:fs": "export function mkdirSync() {} export function writeFileSync() {} export function appendFileSync() {}",
  "./server.mjs": "export async function assertPortAvailable() {} export async function waitForServer() {}",
};

const mockUrls = Object.fromEntries(Object.entries(mocks).map(([name, source]) => [name, `data:text/javascript,${encodeURIComponent(source)}`]));

test("desktop launcher hides the Next server but not the Electron GUI", () => {
  const script = `
    import assert from 'node:assert/strict';
    import { registerHooks } from 'node:module';
    const mocks = ${JSON.stringify(mockUrls)};
    registerHooks({ resolve(specifier, context, next) {
      return mocks[specifier] ? { url: mocks[specifier], shortCircuit: true } : next(specifier, context);
    }});
    process.env.PORT = '18889';
    process.env.ELECTRON_RUN_AS_NODE = '1';
    const { calls } = await import('node:child_process');
    await import(${JSON.stringify(new URL("./dev.mjs", import.meta.url).href)});
    assert.equal(calls.length, 2);
    assert.equal(calls[0].options.windowsHide, true);
    assert.equal(calls[1].command, 'test-electron.exe');
    assert.equal(calls[1].options.windowsHide, false);
    assert.equal(calls[1].options.env.ELECTRON_RUN_AS_NODE, undefined);
  `;
  const result = execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", stdio: "pipe" });
  assert.match(result, /\[desktop\] 日志:/);
});

for (const parentExitsFirst of [false, true]) {
  test(`POSIX shutdown cleans process groups when parents exit ${parentExitsFirst ? "before shutdown" : "during the grace period"}`, () => {
    const shutdownMocks = {
      ...mockUrls,
      "node:child_process": `data:text/javascript,${encodeURIComponent(`
        import { EventEmitter } from 'node:events';
        export const children = [];
        export function spawn() {
          const child = Object.assign(new EventEmitter(), {
            pid: 10000 + children.length,
            stdout: new EventEmitter(), stderr: new EventEmitter(),
            exitCode: null, signalCode: null
          });
          children.push(child);
          return child;
        }
        export function spawnSync() { throw new Error('Unexpected taskkill on POSIX'); }
      `)}`,
      "node:timers/promises": `data:text/javascript,${encodeURIComponent("export async function setTimeout() {}")}`,
    };
    const script = `
      import assert from 'node:assert/strict';
      import { registerHooks } from 'node:module';
      Object.defineProperty(process, 'platform', { value: 'linux' });
      const mocks = ${JSON.stringify(shutdownMocks)};
      registerHooks({ resolve(specifier, context, next) {
        return mocks[specifier] ? { url: mocks[specifier], shortCircuit: true } : next(specifier, context);
      }});
      const { children } = await import('node:child_process');
      const signals = [];
      process.kill = (pid, signal) => {
        signals.push({ pid, signal });
        if (signal === 'SIGTERM') {
          const child = children.find(child => child.pid === -pid);
          child.exitCode = 0;
          child.emit('exit', 0, null);
        }
      };
      process.env.PORT = '18889';
      await import(${JSON.stringify(new URL("./dev.mjs", import.meta.url).href)});
      if (${parentExitsFirst}) {
        children[1].exitCode = 0;
        children[1].emit('exit', 0, null);
      } else {
        process.emit('SIGINT');
      }
      await new Promise(resolve => setImmediate(resolve));
      for (const child of children) {
        assert.ok(signals.some(call => call.pid === -child.pid && call.signal === 'SIGTERM'));
        assert.ok(signals.some(call => call.pid === -child.pid && call.signal === 'SIGKILL'),
          'must clean the group even after its parent exits');
      }
      // 已消失的进程组是正常情况，不应让退出失败。
      process.kill = () => { throw Object.assign(new Error('No such process'), { code: 'ESRCH' }); };
    `;
    execFileSync(process.execPath, ["--input-type=module", "-e", script], { stdio: "pipe" });
  });
}
