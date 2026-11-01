import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import electron from "electron";
import { assertPortAvailable, waitForServer } from "./server.mjs";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));
const port = Number(process.env.PORT ?? 8888);
const url = `http://127.0.0.1:${port}`;
const logFile = fileURLToPath(new URL("../node_modules/.cache/weclio-desktop.log", import.meta.url));
const children = new Set();
const controller = new AbortController();
let stopping = false;
let serverOutput = "";

function record(chunk) {
  try { appendFileSync(logFile, chunk); }
  catch (error) { console.error(`[desktop] 无法保存日志: ${error.message}`); }
}

function stopTree(child) {
  if (!child.pid) return;
  // Windows 上 Next 和 Chromium 都有子进程，不能只结束直接子进程。
  if (process.platform === "win32") {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const result = spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 10_000 });
    if (result.error || result.status !== 0) {
      console.error(`[desktop] 无法清理进程 ${child.pid}:`, result.error?.message ?? result.stderr?.toString());
    }
  } else {
    // 组长退出后仍可能有后代存活，不能根据组长状态跳过进程组清理。
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") console.error("[desktop] 无法清理进程:", error);
    }
  }
}

async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  record(`[desktop] 停止启动器 (${code})\n`);
  controller.abort();
  process.exitCode = code;
  // POSIX 先通知整个进程组退出，超时后再强制清理；Windows 使用进程树清理。
  if (process.platform !== "win32") {
    for (const child of children) {
      if (child.pid) {
        try { process.kill(-child.pid, "SIGTERM"); }
        catch (error) { if (error.code !== "ESRCH") console.error(error); }
      }
    }
    await delay(1000);
  }
  for (const child of children) stopTree(child);
}

function launch(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: root,
    windowsHide: true,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
  children.add(child);
  child.stdout.on("data", (chunk) => {
    process.stdout.write(chunk);
    record(chunk);
    if (command === process.execPath) serverOutput = (serverOutput + chunk.toString()).slice(-8192);
  });
  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
    record(chunk);
  });
  child.on("error", (error) => {
    const message = `[desktop] 启动失败: ${error.message}`;
    console.error(message);
    record(`${message}\n`);
    void stop(1);
  });
  child.on("exit", (code, signal) => {
    if (stopping) return;
    const failed = command === process.execPath || code !== 0;
    const message = `[desktop] ${command === process.execPath ? "Next 服务" : "Electron"} 已退出 (${code ?? signal})。`;
    console.log(message);
    record(`${message}\n`);
    void stop(failed ? 1 : 0);
  });
  return child;
}

process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
process.once("exit", () => { for (const child of children) stopTree(child); });

try {
  mkdirSync(new URL("../node_modules/.cache/", import.meta.url), { recursive: true });
  writeFileSync(logFile, `[desktop] ${new Date().toISOString()} 启动 ${url}\n`);
  console.log(`[desktop] 日志: ${logFile}`);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT 必须是 1–65535 的整数。");
  await assertPortAvailable(port);
  if (!stopping) {
    const server = launch(process.execPath, [require.resolve("next/dist/bin/next"), "dev", "-H", "127.0.0.1", "-p", String(port)], {
      env: { ...process.env, PI_WEB_HOSTNAME: "127.0.0.1" },
    });
    // 只探测本次启动的 Next 宣告就绪后的 HTTP 响应，不将已有服务误认为启动成功。
    await waitForServer(url, {
      signal: controller.signal,
      isReady: () => /Ready in/.test(serverOutput) && server.exitCode === null && server.signalCode === null,
    });
    if (!stopping) {
      const env = { ...process.env, WECLIO_DESKTOP_URL: url };
      delete env.ELECTRON_RUN_AS_NODE;
      // windowsHide 会隐藏 GUI 窗口，只能用于后台服务。
      launch(electron, [fileURLToPath(new URL("./main.mjs", import.meta.url)), ...process.argv.slice(2)], { env, windowsHide: false });
    }
  }
} catch (error) {
  if (!stopping) {
    console.error(`[desktop] ${error.message}`);
    record(`[desktop] ${error.stack ?? error.message}\n`);
    await stop(1);
  }
}
