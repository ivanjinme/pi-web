import { createHash, createPublicKey, verify } from "node:crypto";
import { updateUrl } from "./update-signature.mjs";

export const APPLICATION_MANIFEST_NAME = "desktop-application-manifest.json";
export const APPLICATION_PROTOCOL = 1;
export const LIMITS = Object.freeze({ manifestBytes: 65536, layoutBytes: 16 * 1024 * 1024, archiveBytes: 2 * 1024 ** 3, expandedBytes: 4 * 1024 ** 3, files: 100000 });

const HEX256 = /^[0-9a-f]{64}$/;
const ROOT_FILES = new Set(["package.json", "next.config.js", "desktop-packages.mjs", "LICENSE"]);
const ROOT_DIRS = new Set(["public", ".next", "node_modules"]);
export const APPLICATION_STARTUP_FILES = Object.freeze(["package.json", "next.config.js", "desktop-packages.mjs", ".next/BUILD_ID", ".next/required-server-files.json", "node_modules/next/dist/bin/next"]);

function invalid(message) {
  throw new Error(`Invalid application ${message}`);
}

function exact(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) invalid("fields");
}

function integer(value, min, max) {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}

function hash(value) {
  return typeof value === "string" && HEX256.test(value);
}

export function isStableVersion(value) {
  return typeof value === "string" && value.length <= 256 && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value) && value.split(".").every((part) => Number.isSafeInteger(Number(part)));
}

export function compareVersions(a, b) {
  if (!isStableVersion(a) || !isStableVersion(b)) invalid("version");
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

function base64(value, size, max = size) {
  if (typeof value !== "string" || value.length > 4 * Math.ceil(max / 3) || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) invalid("base64");
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value || (size !== undefined && bytes.length !== size) || bytes.length > max) invalid("base64 length");
  return bytes;
}

function applicationUrl(value, devFixture) {
  const url = updateUrl(value, devFixture);
  // 旧 EXE 验证器不变；新协议仅向本机 IPv4 测试服务放行 HTTP。
  if (url.protocol === "http:" && url.hostname !== "127.0.0.1") invalid("URL");
  return url;
}

function artifact(value, extension, limit, devFixture, layout = false) {
  exact(value, layout ? ["url", "size", "sha512", "fileCount", "bytes"] : ["url", "size", "sha512"]);
  const url = applicationUrl(value.url, devFixture);
  if (!url.pathname.endsWith(extension) || !integer(value.size, 1, limit)) invalid("artifact");
  base64(value.sha512, 64);
  const result = { url: url.href, size: value.size, sha512: value.sha512 };
  if (layout) {
    if (!integer(value.fileCount, 1, LIMITS.files) || !integer(value.bytes, 1, LIMITS.expandedBytes)) invalid("layout limits");
    result.fileCount = value.fileCount;
    result.bytes = value.bytes;
  }
  return result;
}

export function verifyApplicationManifest(envelope, key, devFixture = false) {
  exact(envelope, ["payload", "signature"]);
  const payload = base64(envelope.payload, undefined, LIMITS.manifestBytes);
  const signature = base64(envelope.signature, 64);
  const publicKey = key?.type === "public" ? key : createPublicKey(key);
  if (publicKey.asymmetricKeyType !== "ed25519" || !verify(null, payload, publicKey, signature)) invalid("signature");
  // 验签后才解析和使用任何发布元数据，且不替换非法 UTF-8 字节。
  const body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload));
  exact(body, ["schema", "type", "version", "platform", "arch", "shell", "toolset", "archive", "layout"]);
  exact(body.shell, ["version", "digest"]);
  if (body.schema !== APPLICATION_PROTOCOL || body.type !== "weclio-application" || body.platform !== "win32" || body.arch !== "x64" || !isStableVersion(body.version) || !isStableVersion(body.shell.version) || !hash(body.shell.digest) || !hash(body.toolset)) invalid("manifest");
  return {
    schema: APPLICATION_PROTOCOL,
    type: "weclio-application",
    version: body.version,
    platform: "win32",
    arch: "x64",
    shell: { version: body.shell.version, digest: body.shell.digest },
    toolset: body.toolset,
    archive: artifact(body.archive, ".zip", LIMITS.archiveBytes, devFixture),
    layout: artifact(body.layout, ".json", LIMITS.layoutBytes, devFixture, true),
    id: createHash("sha256").update(payload).digest("hex"),
  };
}

function validatePath(path) {
  if (typeof path !== "string" || !path || path.length > 240 || /[<>:"\\|?*\p{Cc}]/u.test(path)) invalid("path");
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part))) invalid("path segment");
  if (!(parts.length === 1 ? ROOT_FILES.has(parts[0]) : ROOT_DIRS.has(parts[0]))) invalid("path root");
  const lower = path.toLowerCase();
  if (/\.(?:js|cjs|mjs|jsx|ts|cts|mts|tsx|css)\.map$/.test(lower) || (parts[0] === ".next" && (/^\.next\/(?:cache|trace|trace-build)(?:\/|$)/.test(lower) || lower.endsWith(".nft.json")))) invalid("deployment path");
  return parts;
}

export function validateLayout(json, release) {
  exact(json, ["schema", "files"]);
  const expected = release?.layout;
  if (json.schema !== APPLICATION_PROTOCOL || !Array.isArray(json.files) || !integer(json.files.length, 1, LIMITS.files) || !integer(expected?.fileCount, 1, LIMITS.files) || !integer(expected?.bytes, 1, LIMITS.expandedBytes) || json.files.length !== expected.fileCount) invalid("layout");
  const nodes = new Map();
  const files = [];
  let total = 0;
  for (const entry of json.files) {
    exact(entry, ["path", "size", "sha256"]);
    const parts = validatePath(entry.path);
    if (!integer(entry.size, 0, LIMITS.expandedBytes) || !hash(entry.sha256)) invalid("file metadata");
    total += entry.size;
    if (!Number.isSafeInteger(total) || total > LIMITS.expandedBytes) invalid("expanded bytes");
    for (let index = 0; index < parts.length; index += 1) {
      const path = parts.slice(0, index + 1).join("/");
      const directory = index < parts.length - 1;
      const canonical = path.toLowerCase();
      const previous = nodes.get(canonical);
      if (previous && (previous.path !== path || !previous.directory || !directory)) invalid("path collision");
      nodes.set(canonical, { path, directory });
    }
    files.push({ path: entry.path, size: entry.size, sha256: entry.sha256 });
  }
  if (total !== expected.bytes || APPLICATION_STARTUP_FILES.some((path) => !nodes.has(path.toLowerCase()) || nodes.get(path.toLowerCase()).directory || nodes.get(path.toLowerCase()).path !== path)) invalid("required files or totals");
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { schema: APPLICATION_PROTOCOL, files };
}

export function compatibleApplication(release, shell) {
  // 壳版本号随打包版本号变化，但壳内容未变时摘要不变；兼容性以内容和工具为准。
  return !!(shell && shell.schema === APPLICATION_PROTOCOL && isStableVersion(shell.version) && hash(shell.digest) && hash(shell.toolset) && release?.shell && isStableVersion(release.shell.version) && hash(release.shell.digest) && hash(release.toolset) && release.shell.digest === shell.digest && release.toolset === shell.toolset);
}

export function applicationManifestUrl(legacyUrl, devFixture = false) {
  try {
    const url = applicationUrl(legacyUrl, devFixture);
    if (!url.pathname.endsWith("/desktop-update-manifest.json")) return null;
    url.pathname = url.pathname.slice(0, -"desktop-update-manifest.json".length) + APPLICATION_MANIFEST_NAME;
    return url;
  } catch {
    return null;
  }
}
