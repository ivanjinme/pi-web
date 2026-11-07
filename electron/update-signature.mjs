import { createPublicKey, verify } from "node:crypto";

export function updateUrl(value, devFixture = false) {
  if (typeof value !== "string") throw new Error("Missing update URL");
  const url = new URL(value);
  const loopback = devFixture && url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname);
  if ((!loopback && url.protocol !== "https:") || url.username || url.password || url.hash) throw new Error("Unsafe update URL");
  return url;
}

function base64(value, size) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error("Invalid base64");
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value || (size && bytes.length !== size)) throw new Error("Invalid base64 length");
  return bytes;
}

export function updateKey(pem) {
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Update key must be Ed25519");
  return key;
}

export function verifyManifest(envelope, key, devFixture = false) {
  const payload = base64(envelope.payload);
  if (!verify(null, payload, key, base64(envelope.signature, 64))) throw new Error("Invalid update signature");
  const info = JSON.parse(payload.toString("utf8"));
  // 只接受完整离线 EXE；不把签名以外的数据混入 updater。
  if (typeof info.version !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(info.version) ||
      info.version.length > 256 || info.version.split(".").some((part) => !Number.isSafeInteger(Number(part))) ||
      !Array.isArray(info.files) || info.files.length === 0 || "packages" in info || "path" in info) throw new Error("Invalid stable update manifest");
  for (const file of info.files) {
    const url = updateUrl(file.url, devFixture);
    if (!url.pathname.endsWith(".exe") || !Number.isSafeInteger(file.size) || file.size <= 0) throw new Error("Invalid EXE metadata");
    base64(file.sha512, 64);
  }
  return info;
}
