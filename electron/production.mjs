import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import nodeVersion from "../bin/node-version.js";
import { createRuntimeEnvironment } from "./runtime.mjs";
import { assertPortAvailable, waitForServer } from "./server.mjs";
import { createUpdateGate } from "./update-gate.mjs";

export function resolveSystemNode(env = process.env) {
  const options = { env, encoding: "utf8", windowsHide: true, timeout: 10_000 };
  const probe = spawnSync(process.platform === "win32" ? "node.exe" : "node", ["-p", "JSON.stringify({executable:process.execPath,version:process.versions.node,arch:process.arch})"], options);
  if (probe.error || probe.status !== 0) throw new Error("未找到可用的 Node.js。请安装 Node.js 22.19+（含 npm），然后重新打开 Weclio。");
  const node = JSON.parse(probe.stdout.trim());
  if (!nodeVersion.isNodeVersionSupported(node.version)) throw new Error(nodeVersion.getUnsupportedNodeVersionMessage(node.version));
  if (process.platform === "win32" && node.arch !== "x64") throw new Error("此安装包需要 Windows x64 版 Node.js。");
  const npm = join(dirname(node.executable), "node_modules", "npm", "bin", "npm-cli.js");
  if (!existsSync(npm)) throw new Error("Node.js 安装缺少 npm，请使用包含 npm 的完整 Node.js 安装程序。");
  const npmProbe = spawnSync(node.executable, [npm, "--version"], options);
  if (npmProbe.error || npmProbe.status !== 0) throw new Error("npm 无法运行，请修复 Node.js/npm 安装后重试。");
  return node.executable;
}

export async function startProductionServer({ resourcesPath, logsPath, url, onUnexpectedExit, signal }) {
  const root = join(resourcesPath, "server");
  if (!existsSync(join(root, ".next", "BUILD_ID"))) throw new Error("安装包缺少 Web 生产构建，请重新安装 Weclio。");
  const runtime = join(resourcesPath, "runtime", "win-x64");
  for (const file of ["git/bin/bash.exe", "git/cmd/git.exe", "tools/rg.exe", "tools/fd.exe"]) {
    if (!existsSync(join(runtime, file))) throw new Error(`安装包缺少运行工具: ${file}`);
  }
  const env = { ...createRuntimeEnvironment(runtime), NODE_ENV: "production", PI_WEB_HOSTNAME: "127.0.0.1" };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const key of Object.keys(env)) {
    if (key === "TURBOPACK" || key === "NEXT_RUNTIME" || key.startsWith("__NEXT_")) delete env[key];
  }
  const node = resolveSystemNode(env);
  const address = new URL(url);
  const port = Number(address.port || 80);
  await assertPortAvailable(port);
  mkdirSync(logsPath, { recursive: true });
  const logFile = join(logsPath, "server.log");
  const record = (chunk) => {
    try { appendFileSync(logFile, chunk); }
    catch (error) { console.error(`[desktop] 无法保存服务日志: ${error.message}`); }
  };
  // 在系统 Node 中运行初始化，避免 Electron 的 ASAR/模块解析影响 CLI 与扩展。
  signal?.throwIfAborted();
  await new Promise((resolve, reject) => {
    const bootstrap = spawn(node, [join(root, "desktop-packages.mjs")], {
      cwd: root, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], timeout: 120_000, signal,
    });
    let output = "";
    let failure;
    bootstrap.stdout.on("data", record);
    bootstrap.stderr.on("data", (chunk) => {
      record(chunk);
      output = (output + chunk.toString()).slice(-8192);
    });
    bootstrap.once("error", (error) => { failure = error; });
    // 等待 close，确保取消或超时后初始化进程已结束，再允许重试。
    bootstrap.once("close", (code) => {
      if (!failure && code === 0) return resolve();
      const message = failure?.message ?? (bootstrap.killed ? "初始化超时，请重新打开 Weclio 重试。" : output || `退出码 ${code}`);
      reject(new Error(`内置包初始化失败: ${message}\n服务日志: ${logFile}`));
    });
  });
  signal?.throwIfAborted();
  const require = createRequire(import.meta.url);
  const next = require.resolve(join(root, "node_modules", "next", "dist", "bin", "next"));
  const child = spawn(node, [next, "start", "-H", "127.0.0.1", "-p", String(port)], {
    cwd: root, env: { ...env, WECLIO_DESKTOP_UPDATE_IPC: "1" }, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const updateGate = createUpdateGate(child);
  const controller = new AbortController();
  let ready = false;
  let stopping = false;
  let output = "";
  let failure;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    updateGate.dispose({ unlock: false });
    controller.abort();
    process.off("exit", stop);
    signal?.removeEventListener("abort", stop);
    if (!child.pid) return;
    if (process.platform === "win32") {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const result = spawnSync(join(process.env.SystemRoot, "System32", "taskkill.exe"), ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 10_000 });
      if (result.error || result.status !== 0) record(`[desktop] 服务清理失败: ${result.error?.message ?? result.stderr}\n`);
    } else {
      try { process.kill(-child.pid, "SIGTERM"); }
      catch (error) { if (error.code !== "ESRCH") console.error(error); }
    }
  };
  process.once("exit", stop);
  child.stdout.on("data", (chunk) => {
    record(chunk);
    output = (output + chunk.toString()).slice(-8192);
  });
  child.stderr.on("data", record);
  const failed = (error) => {
    if (stopping) return;
    failure = error;
    updateGate.dispose({ unlock: false });
    record(`[desktop] ${error.message}\n`);
    controller.abort();
    if (ready) onUnexpectedExit(error);
  };
  child.once("error", failed);
  child.once("exit", (code, signal) => failed(new Error(`Web 服务已退出 (${code ?? signal})。日志: ${logFile}`)));
  signal?.addEventListener("abort", stop, { once: true });
  if (signal?.aborted) stop();
  try {
    await waitForServer(url, {
      signal: controller.signal,
      isReady: () => /Ready in/.test(output) && child.exitCode === null && child.signalCode === null,
    });
    if (failure) throw failure;
    ready = true;
    return { stop, logFile, updateGate };
  } catch (error) {
    stop();
    throw failure ?? new Error(`${error.message}\n服务日志: ${logFile}`);
  }
}
