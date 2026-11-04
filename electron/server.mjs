import net from "node:net";
import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";

export function assertPortAvailable(port) {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", (error) => reject(new Error(
      error.code === "EADDRINUSE"
        ? `端口 ${port} 已被占用。请先关闭占用该端口的服务，再启动桌面；不会结束或复用已有服务。`
        : `无法监听 127.0.0.1:${port}: ${error.message}`,
    )));
    probe.listen(port, "127.0.0.1", () => probe.close(resolve));
  });
}

function responds(url, signal) {
  return new Promise((resolve) => {
    const request = http.get(url, { signal, agent: false }, (response) => {
      response.once("end", () => resolve(response.statusCode === 200));
      response.once("error", () => resolve(false));
      response.resume();
    });
    request.setTimeout(2000, () => request.destroy());
    request.once("error", () => resolve(false));
  });
}

export async function waitForServer(url, { signal, isReady, timeout = 120_000 }) {
  const deadline = AbortSignal.timeout(timeout);
  const combined = AbortSignal.any([signal, deadline]);
  try {
    while (true) {
      combined.throwIfAborted();
      if (isReady() && await responds(url, combined)) return;
      await delay(250, undefined, { signal: combined });
    }
  } catch (error) {
    if (!signal.aborted && deadline.aborted) throw new Error(`Next 服务在 ${timeout / 1000} 秒内未就绪，请检查上方服务日志。`);
    throw error;
  }
}
