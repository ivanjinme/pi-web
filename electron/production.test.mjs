import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { resolveSystemNode, startProductionServer } from "./production.mjs";
import { createRuntimeEnvironment } from "./runtime.mjs";

const runtime = resolve("resources/runtime/win-x64");

test("production resolves an installed Node and npm without using Electron as Node", () => {
  assert.equal(resolveSystemNode(), process.execPath);
});

test("missing system Node produces an actionable installation error", async (t) => {
  const empty = await mkdtemp(join(tmpdir(), "weclio-no-node-"));
  t.after(() => rm(empty, { recursive: true, force: true }));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toLowerCase() === "path") delete env[key];
  env.PATH = empty;
  assert.throws(() => resolveSystemNode(env), /请安装 Node.js 22.19\+/);
});

test("unsupported Node versions and missing npm are rejected before launching the service", () => {
  for (const [version, expected] of [["22.18.0", /22\.19\.0/], ["24.0.0", /缺少 npm/]]) {
    const mock = `export function spawn() { throw new Error('Service must not start'); } export function spawnSync() { return {status:0,stdout:JSON.stringify({version:${JSON.stringify(version)},executable:'C:/missing-node/node.exe',arch:'x64'})}; }`;
    const script = `
      import assert from 'node:assert/strict';
      import { registerHooks } from 'node:module';
      registerHooks({resolve(name, context, next) {
        return name === 'node:child_process' ? {url:${JSON.stringify(`data:text/javascript,${encodeURIComponent(mock)}`)},shortCircuit:true} : next(name, context);
      }});
      const { resolveSystemNode } = await import(${JSON.stringify(new URL("./production.mjs", import.meta.url).href)});
      assert.throws(() => resolveSystemNode(), ${expected});
    `;
    execFileSync(process.execPath, ["--input-type=module", "-e", script], { stdio: "pipe" });
  }
});

test("production initializes bundled packages before Next and never initializes against an occupied port", async (t) => {
  const resources = await mkdtemp(join(tmpdir(), "weclio-bootstrap-order-"));
  t.after(() => rm(resources, { recursive: true, force: true }));
  for (const file of ["server/.next/BUILD_ID", "runtime/win-x64/git/bin/bash.exe", "runtime/win-x64/git/cmd/git.exe", "runtime/win-x64/tools/rg.exe", "runtime/win-x64/tools/fd.exe"]) {
    await mkdir(dirname(join(resources, file)), { recursive: true });
    await writeFile(join(resources, file), "fixture");
  }
  const mock = `
    import {EventEmitter} from 'node:events';
    export function spawn(command, args, options) {
      if(!args[0].endsWith('desktop-packages.mjs'))throw Error('Next must not start after failed bootstrap');
      globalThis.bootstrapCalls=(globalThis.bootstrapCalls??0)+1;
      if(options.cwd!==${JSON.stringify(join(resources, "server"))})throw Error('Wrong bootstrap root');
      if(options.timeout!==120000)throw Error('Initialization timeout must allow slow first use');
      const child=Object.assign(new EventEmitter(),{stdout:new EventEmitter(),stderr:new EventEmitter()});
      setImmediate(()=>{child.stderr.emit('data','fixture initialization failure');child.emit('close',1);});
      return child;
    }
    export function spawnSync(command, args) {
      if (args[0] === '-p') return {status:0,stdout:JSON.stringify({executable:process.execPath,version:process.versions.node,arch:'x64'})};
      if (args[0].endsWith('npm-cli.js')) return {status:0,stdout:'11.0.0'};
      throw Error('Unexpected process');
    }
  `;
  const script = `
    import assert from 'node:assert/strict';
    import http from 'node:http';
    import {once} from 'node:events';
    import {registerHooks} from 'node:module';
    registerHooks({resolve(name, context, next) {
      return name==='node:child_process'?{url:${JSON.stringify(`data:text/javascript,${encodeURIComponent(mock)}`)},shortCircuit:true}:next(name,context);
    }});
    const {startProductionServer}=await import(${JSON.stringify(new URL("./production.mjs", import.meta.url).href)});
    const server=http.createServer((_req,res)=>res.end('existing'));
    server.listen(0,'127.0.0.1');await once(server,'listening');
    const url='http://127.0.0.1:'+server.address().port;
    const options={resourcesPath:${JSON.stringify(resources)},logsPath:${JSON.stringify(join(resources, "logs"))},url};
    await assert.rejects(startProductionServer(options),/已被占用/);
    assert.equal(globalThis.bootstrapCalls,undefined);
    assert.equal(await(await fetch(url)).text(),'existing');
    await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});
    await assert.rejects(startProductionServer(options),/内置包初始化失败.*fixture initialization failure/);
    assert.equal(globalThis.bootstrapCalls,1);
  `;
  execFileSync(process.execPath, ["--input-type=module", "-e", script], { stdio: "pipe", timeout: 20_000 });
});

test("cancelling first startup terminates its initializer before returning", async (t) => {
  const resources = await mkdtemp(join(tmpdir(), "weclio-cancel-bootstrap-"));
  t.after(() => rm(resources, { recursive: true, force: true }));
  for (const file of ["server/.next/BUILD_ID", "runtime/win-x64/git/bin/bash.exe", "runtime/win-x64/git/cmd/git.exe", "runtime/win-x64/tools/rg.exe", "runtime/win-x64/tools/fd.exe"]) {
    await mkdir(dirname(join(resources, file)), { recursive: true });
    await writeFile(join(resources, file), "fixture");
  }
  const pidFile = join(resources, "initializer-pid");
  await writeFile(join(resources, "server/desktop-packages.mjs"), `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000);`);
  const controller = new AbortController();
  const result = startProductionServer({ resourcesPath: resources, logsPath: join(resources, "logs"), url: "http://127.0.0.1:0", signal: controller.signal }).catch((error) => error);
  try {
    for (let attempt = 0; attempt < 200 && !existsSync(pidFile); attempt++) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(existsSync(pidFile), true);
    const pid = Number(await readFile(pidFile, "utf8"));
    controller.abort();
    assert.match((await result).message, /内置包初始化失败/);
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally {
    controller.abort();
    await result;
  }
});

test("only the Next child owns update IPC and unexpected exits still surface", async (t) => {
  const resources = await mkdtemp(join(tmpdir(), "weclio-production-ipc-"));
  t.after(() => rm(resources, { recursive: true, force: true }));
  for (const file of ["server/.next/BUILD_ID", "server/node_modules/next/dist/bin/next", "runtime/win-x64/git/bin/bash.exe", "runtime/win-x64/git/cmd/git.exe", "runtime/win-x64/tools/rg.exe", "runtime/win-x64/tools/fd.exe"]) {
    await mkdir(dirname(join(resources, file)), { recursive: true });
    await writeFile(join(resources, file), "fixture");
  }
  const mock = `
    import assert from 'node:assert/strict';
    import {EventEmitter} from 'node:events';
    export function spawn(command,args,options) {
      const child=Object.assign(new EventEmitter(),{stdout:new EventEmitter(),stderr:new EventEmitter(),connected:true,exitCode:null,signalCode:null});
      child.send=(message,cb)=>{cb?.();queueMicrotask(()=>child.emit('message',{type:'weclio-desktop-update-result',id:message.id,status:'ready'}));};
      if(args[0].endsWith('desktop-packages.mjs')) {
        assert.deepEqual(options.stdio,['ignore','pipe','pipe']);
        assert.equal(options.env.WECLIO_DESKTOP_UPDATE_IPC,undefined);
        queueMicrotask(()=>child.emit('close',0));
      } else {
        assert.deepEqual(options.stdio,['ignore','pipe','pipe','ipc']);
        assert.equal(options.env.WECLIO_DESKTOP_UPDATE_IPC,'1');
        globalThis.fixtureNext=child;
        queueMicrotask(()=>child.stdout.emit('data','Ready in fixture'));
      }
      return child;
    }
    export function spawnSync(command,args) {
      if(args[0]==='-p')return {status:0,stdout:JSON.stringify({executable:process.execPath,version:process.versions.node,arch:'x64'})};
      return {status:0,stdout:'11.0.0'};
    }
  `;
  const serverMock = `export async function assertPortAvailable(){};export async function waitForServer(url,options){await Promise.resolve();if(!options.isReady())throw Error('Not ready');}`;
  const script = `
    import assert from 'node:assert/strict';
    import {registerHooks} from 'node:module';
    registerHooks({resolve(name,context,next){
      if(name==='node:child_process')return {url:${JSON.stringify(`data:text/javascript,${encodeURIComponent(mock)}`)},shortCircuit:true};
      if(name==='./server.mjs')return {url:${JSON.stringify(`data:text/javascript,${encodeURIComponent(serverMock)}`)},shortCircuit:true};
      return next(name,context);
    }});
    const {startProductionServer}=await import(${JSON.stringify(new URL("./production.mjs", import.meta.url).href)});
    let failure;
    const server=await startProductionServer({resourcesPath:${JSON.stringify(resources)},logsPath:${JSON.stringify(join(resources, "logs"))},url:'http://127.0.0.1:0',onUnexpectedExit:error=>{failure=error;}});
    assert.equal(await server.updateGate.lock(),'ready');
    const pending=server.updateGate.inspect();
    globalThis.fixtureNext.emit('exit',1);
    await assert.rejects(pending,/exited/);
    assert.match(failure.message,/Web 服务已退出/);
    assert.equal(globalThis.fixtureNext.listenerCount('message'),0);
    server.stop();
  `;
  execFileSync(process.execPath, ["--input-type=module", "-e", script], { stdio: "pipe", timeout: 20_000 });
});

test("with no system Git, Pi discovers bundled Bash, rg and fd through only the child PATH", {
  skip: process.platform !== "win32" || !existsSync(join(runtime, "git/bin/bash.exe")),
}, async (t) => {
  const agent = await mkdtemp(join(tmpdir(), "weclio-runtime-agent-"));
  t.after(() => rm(agent, { recursive: true, force: true }));
  const base = { ...process.env };
  for (const key of Object.keys(base)) if (key.toLowerCase() === "path") delete base[key];
  Object.assign(base, {
    PATH: `${dirname(process.execPath)};${join(process.env.SystemRoot, "System32")}`,
    ProgramFiles: agent, "ProgramFiles(x86)": agent, PI_CODING_AGENT_DIR: agent,
  });
  delete base.BASH_ENV;
  const env = createRuntimeEnvironment(runtime, base);
  const script = `
    import assert from 'node:assert/strict';
    import { execFileSync } from 'node:child_process';
    import { getShellConfig } from '@earendil-works/pi-coding-agent';
    const { getToolPath } = await import(${JSON.stringify(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/utils/tools-manager.js", import.meta.url).href)});
    const shell = getShellConfig();
    assert.equal(shell.shell.toLowerCase(), ${JSON.stringify(join(runtime, "git/bin/bash.exe").toLowerCase())});
    assert.equal(getToolPath('rg'), 'rg');
    assert.equal(getToolPath('fd'), 'fd');
    const output=execFileSync(shell.shell,[...shell.args,'git --version && rg --version && fd --version'],{encoding:'utf8',windowsHide:true});
    assert.match(output,/git version/); assert.match(output,/ripgrep/); assert.match(output,/fd /);
  `;
  execFileSync(process.execPath, ["--input-type=module", "-e", script], { env, stdio: "pipe", timeout: 30000 });
});
