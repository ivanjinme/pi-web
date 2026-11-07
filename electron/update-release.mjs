import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { updateKey, verifyManifest } from "./update-signature.mjs";

const require = createRequire(import.meta.url);
const { sanitizeFileName } = require("builder-util/out/filename.js");
export const MANIFEST_NAME = "desktop-update-manifest.json";
export const DEFAULT_KEY_PATH = join(homedir(), ".weclio/release-keys/desktop-update.ed25519.pem");
const defaultKeyPath = () => process.env.WECLIO_DESKTOP_SIGNING_KEY ?? DEFAULT_KEY_PATH;

async function exists(file) {
  try { await lstat(file); return true; } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function inside(root, file) {
  const part = relative(root, file);
  return part === "" || (!isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`));
}

// 对尚不存在的密钥路径，也解析其最近存在的父目录，阻止目录别名绕过仓库边界。
async function canonical(file) {
  try { return await realpath(file); } catch (error) {
    if (error.code !== "ENOENT") throw error;
    if (await exists(file)) throw new Error("Signing key path contains a broken symbolic link");
    const parent = dirname(file);
    if (parent === file) throw new Error("Signing key path has no existing filesystem root");
    return join(await canonical(parent), basename(file));
  }
}

async function externalKeyPath(root, keyPath) {
  if (typeof keyPath !== "string" || !isAbsolute(keyPath)) throw new Error("Signing key path must be absolute and outside the repository");
  keyPath = resolve(keyPath);
  if (inside(resolve(root), keyPath) || inside(await realpath(root), await canonical(keyPath))) {
    throw new Error("Signing key must be outside the repository");
  }
  return keyPath;
}

async function expectedConfig(root) {
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const builder = JSON.parse(await readFile(join(root, "electron/builder.json"), "utf8"));
  const source = pkg.repository?.url;
  const match = typeof source === "string" && /^(?:git\+)?https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(source);
  if (!match || [match[1], match[2]].some((part) => part === "." || part === "..")) throw new Error("package.json must specify a GitHub HTTPS repository.url");
  const name = builder.extraMetadata?.name ?? pkg.name;
  if (typeof name !== "string" || !name) throw new Error("Missing packager application name");
  return {
    manifestUrl: `https://github.com/${match[1]}/${match[2]}/releases/latest/download/${MANIFEST_NAME}`,
    updaterCacheDirName: sanitizeFileName(name).toLowerCase() + "-updater",
  };
}

function publicPem(privateKey) {
  return createPublicKey(privateKey).export({ format: "pem", type: "spki" }).toString();
}

async function readPrivateKey(keyPath) {
  // 不回显 OpenSSL 错误或输入内容，避免将私钥材料带入日志。
  try {
    const privateKey = createPrivateKey(await readFile(keyPath));
    if (privateKey.asymmetricKeyType !== "ed25519") throw new Error();
    return privateKey;
  } catch {
    throw new Error("Cannot read Ed25519 signing key; restore the correct private key from backup");
  }
}

function checkConfig(config, expected, privateKey) {
  if (!config || config.manifestUrl !== expected.manifestUrl || config.updaterCacheDirName !== expected.updaterCacheDirName || config.publicKey !== publicPem(privateKey)) {
    throw new Error("Desktop update config does not match the signing key, repository, or packager cache name");
  }
}

export async function initializeUpdateSigning({ root, keyPath = defaultKeyPath() }) {
  keyPath = await externalKeyPath(root, keyPath);
  const configPath = join(root, "resources/desktop-update.json");
  const expected = await expectedConfig(root);
  const hasConfig = await exists(configPath);
  const hasKey = await exists(keyPath);
  if (hasConfig && !hasKey) throw new Error("Signing key is missing; restore the private key from backup. No new key was generated");
  let created = false;
  let privateKey;
  if (hasKey) {
    privateKey = await readPrivateKey(keyPath);
  } else {
    privateKey = generateKeyPairSync("ed25519").privateKey;
    await mkdir(dirname(keyPath), { recursive: true, mode: 0o700 });
    // wx 保护已有密钥，即使另一进程在检查后抢先创建文件也不覆盖。
    await writeFile(keyPath, privateKey.export({ format: "pem", type: "pkcs8" }), { flag: "wx", mode: 0o600 });
    created = true;
  }
  if (hasConfig) {
    const config = JSON.parse(await readFile(configPath, "utf8"));
    checkConfig(config, expected, privateKey);
  } else {
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, JSON.stringify({ ...expected, publicKey: publicPem(privateKey) }, null, 2) + "\n", { flag: "wx" });
  }
  return { configPath, keyPath, created };
}

export async function readReleaseSigning({ root, keyPath = defaultKeyPath() }) {
  keyPath = await externalKeyPath(root, keyPath);
  const configPath = join(root, "resources/desktop-update.json");
  if (!await exists(configPath)) throw new Error("Desktop update config is missing; run signing initialization first");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const privateKey = await readPrivateKey(keyPath);
  checkConfig(config, await expectedConfig(root), privateKey);
  return { config, privateKey, keyPath };
}

export async function validateInstaller(file) {
  const handle = await open(file, "r");
  try {
    const info = await handle.stat();
    const header = Buffer.alloc(64);
    if (info.size < 64 || (await handle.read(header, 0, 64, 0)).bytesRead !== 64 || header.toString("ascii", 0, 2) !== "MZ") throw new Error("安装包不是有效的 Windows PE 文件。");
    const offset = header.readUInt32LE(60);
    const signature = Buffer.alloc(4);
    // NSIS 安装器外壳可为 32 位；目标架构由 builder 的 --x64 指定。
    if (offset > info.size - 4 || (await handle.read(signature, 0, 4, offset)).bytesRead !== 4 || signature.readUInt32LE(0) !== 0x4550) throw new Error("安装包 PE 签名无效。");
  } finally {
    await handle.close();
  }
  return hashFile(file, "sha256", "hex");
}

async function hashFile(file, algorithm, encoding) {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest(encoding);
}

export async function prepareSignedUpdate({ version, installerPath, blockmapPath, signing }) {
  if (typeof version !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version) || version.length > 256 || version.split(".").some((part) => !Number.isSafeInteger(Number(part)))) throw new Error("A stable semver version is required");
  const name = `Weclio-${version}-x64-Setup.exe`;
  if (basename(installerPath) !== name || basename(blockmapPath) !== `${name}.blockmap` || await realpath(dirname(installerPath)) !== await realpath(dirname(blockmapPath))) throw new Error("Installer and blockmap must have the expected names in the same output directory");
  const installerInfo = await stat(installerPath);
  const blockmapInfo = await stat(blockmapPath);
  if (!installerInfo.isFile() || !blockmapInfo.isFile() || blockmapInfo.size === 0) throw new Error("Installer and nonempty regular blockmap files are required");
  const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/releases\/latest\/download\/desktop-update-manifest\.json$/.exec(signing.config.manifestUrl);
  if (!match || [match[1], match[2]].some((part) => part === "." || part === "..")) throw new Error("Invalid GitHub latest update manifest URL");
  if (signing.privateKey?.asymmetricKeyType !== "ed25519" || signing.config.publicKey !== publicPem(signing.privateKey)) throw new Error("Update signing key does not match public config");
  const sha256 = await validateInstaller(installerPath);
  const sha512 = await hashFile(installerPath, "sha512", "base64");
  const blockmapSha256 = await hashFile(blockmapPath, "sha256", "hex");
  const payload = Buffer.from(JSON.stringify({
    version, installable: true,
    files: [{ url: `https://github.com/${match[1]}/${match[2]}/releases/download/desktop-v${version}/${name}`, sha512, size: installerInfo.size }],
  }));
  const envelope = { payload: payload.toString("base64"), signature: sign(null, payload, signing.privateKey).toString("base64") };
  verifyManifest(envelope, updateKey(signing.config.publicKey));
  return { manifestName: MANIFEST_NAME, manifest: JSON.stringify(envelope, null, 2) + "\n", sha256, sha512, size: installerInfo.size, blockmapSha256 };
}

async function main() {
  if (process.argv.length !== 3 || process.argv[2] !== "--init") throw new Error("Usage: node electron/update-release.mjs --init");
  const result = await initializeUpdateSigning({ root: fileURLToPath(new URL("../", import.meta.url)) });
  console.log(`Public config: ${result.configPath}\nPrivate key: ${result.keyPath}\nBack up the private key securely outside the repository. Losing it prevents future signed updates.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(`[desktop-update-signing] ${error.message}`); process.exitCode = 1; });
}
