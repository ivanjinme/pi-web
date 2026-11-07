import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function appOrigin(address) {
  // 仍只接受裸 loopback origin；显式 :80 会被 URL 标准化省略。
  const server = new URL(address);
  if (server.protocol !== "http:" || server.hostname !== "127.0.0.1" || (server.origin !== address && `${server.origin}:80` !== address)) {
    throw new Error("桌面服务地址必须是 http://127.0.0.1:<port>。");
  }
  return server.origin;
}

export let SERVER_URL = appOrigin(process.env.WECLIO_DESKTOP_URL ?? `http://127.0.0.1:${process.env.PORT ?? 8888}`);

export function restoreDesktopPort(userDataPath, env = process.env) {
  const file = join(userDataPath, "desktop-port.json");
  let saved;
  try { saved = JSON.parse(readFileSync(file, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (saved !== undefined && (!Number.isInteger(saved?.port) || saved.port < 1 || saved.port > 65535)) {
    throw new Error("桌面端口配置无效，请修复 desktop-port.json。");
  }
  const explicit = env.WECLIO_DESKTOP_URL ?? (env.PORT !== undefined ? `http://127.0.0.1:${env.PORT}` : undefined);
  const origin = appOrigin(explicit ?? `http://127.0.0.1:${saved?.port ?? 8888}`);
  const port = Number(new URL(origin).port || 80);
  if (port === 0) throw new Error("桌面端口不能为 0。");
  // NSIS 从 Windows shell 重开时可能丢失临时环境变量；仅安装版保存端口。
  if (explicit !== undefined && saved?.port !== port) {
    mkdirSync(userDataPath, { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ port }) + "\n", { mode: 0o600 });
    renameSync(temporary, file);
  }
  SERVER_URL = origin;
  return origin;
}

export function isAppUrl(value) {
  try {
    return new URL(value).origin === SERVER_URL;
  } catch {
    return false;
  }
}

// 仅允许可信应用写入剪贴板；读取剪贴板及其他权限继续拒绝。
export function isPermissionAllowed(permission, requestingUrl) {
  return permission === "clipboard-sanitized-write" && isAppUrl(requestingUrl);
}

export function isExternalUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !isAppUrl(value);
  } catch {
    return false;
  }
}
