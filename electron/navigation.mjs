export const SERVER_URL = process.env.WECLIO_DESKTOP_URL ?? "http://127.0.0.1:8888";

// 桌面只加载由本地启动器提供的 loopback 服务。
const server = new URL(SERVER_URL);
if (server.protocol !== "http:" || server.hostname !== "127.0.0.1" || server.origin !== SERVER_URL) {
  throw new Error("桌面服务地址必须是 http://127.0.0.1:<port>。");
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
