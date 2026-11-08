import { createHash, createPublicKey, sign } from "node:crypto";
import { createReadStream, constants } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { APPLICATION_MANIFEST_NAME, LIMITS, isStableVersion, validateLayout, verifyApplicationManifest } from "./application-manifest.mjs";
import { readReleaseSigning } from "./update-release.mjs";
import { shouldCopyDependencyFile } from "./package-files.mjs";

const HEX256 = /^[0-9a-f]{64}$/;
const ROOTS = ["package.json", "next.config.js", "desktop-packages.mjs", "LICENSE", "public", ".next", "node_modules"];
const portable = (path) => path.replaceAll("\\", "/");
const digest = (bytes, algorithm = "sha256", encoding = "hex") => createHash(algorithm).update(bytes).digest(encoding);

function inside(root, path) {
  const part = relative(root, path);
  return part === "" || (!isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`));
}

async function exists(path) {
  try { await lstat(path); return true; } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function regularRoot(path) {
  path = resolve(path);
  if (!(await lstat(path)).isDirectory() || (await lstat(path)).isSymbolicLink()) throw new Error("A regular directory is required");
  return realpath(path);
}

// 每一级都拒绝链接，避免固定文件路径借父目录跳出仓库。
async function safeStat(root, path) {
  if (!inside(root, path)) throw new Error("Path is outside root");
  const parts = relative(root, path).split(sep).filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw new Error(`Symbolic links are not supported: ${current}`);
  }
  return lstat(path);
}

async function hashFile(path, algorithm = "sha256", encoding = "hex") {
  const hash = createHash(algorithm);
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest(encoding);
}

function validateShell(shell) {
  if (!shell || shell.schema !== 1 || !isStableVersion(shell.version) || typeof shell.digest !== "string" || !HEX256.test(shell.digest) || typeof shell.toolset !== "string" || !HEX256.test(shell.toolset) || Object.keys(shell).sort().join(",") !== "digest,schema,toolset,version") throw new Error("Invalid shell descriptor");
}

export async function createShellDescriptor({ root, version, toolset }) {
  if (!isStableVersion(version) || typeof toolset !== "string" || !HEX256.test(toolset)) throw new Error("Stable shell version and SHA256 toolset are required");
  root = await regularRoot(root);
  const hash = createHash("sha256");
  function add(identity, bytes) {
    hash.update(JSON.stringify([identity, bytes.length]) + "\n");
    hash.update(bytes);
  }
  async function addFile(path) {
    if (!(await safeStat(root, path)).isFile()) throw new Error("Shell inputs must be regular files");
    add(portable(relative(root, path)), await readFile(path));
  }
  const builderPath = join(root, "electron/builder.json");
  await addFile(builderPath);
  const builder = JSON.parse(await readFile(builderPath, "utf8"));
  if (!Array.isArray(builder.files) || builder.files.some((name) => typeof name !== "string")) throw new Error("Invalid builder files");
  for (const name of [...new Set([...builder.files.filter((name) => !name.startsWith("!")), "resources/desktop-update.json", "bin/node-version.js"])].sort()) {
    if (isAbsolute(name) || /[*?\[\]{}]/.test(name)) throw new Error("Shell builder files must be exact paths");
    await addFile(resolve(root, name));
  }
  const pkgPath = join(root, "package.json");
  await safeStat(root, pkgPath);
  const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
  if (typeof pkg.devDependencies?.electron !== "string" || !pkg.devDependencies.electron || typeof pkg.dependencies?.["electron-updater"] !== "string" || !/^\d+\.\d+\.\d+$/.test(pkg.dependencies["electron-updater"])) throw new Error("Electron and pinned updater versions are required");
  add("electron-version", Buffer.from(pkg.devDependencies.electron));
  add("electron-updater-version", Buffer.from(pkg.dependencies["electron-updater"]));
  const visited = new Set();
  async function dependency(name, from) {
    const require = createRequire(from);
    let path;
    // 不加载依赖代码；也适用于 exports 隐藏 package.json 的包。
    for (const directory of require.resolve.paths(name) ?? []) {
      const candidate = join(directory, name, "package.json");
      if (!inside(root, candidate)) continue;
      try {
        if (!(await safeStat(root, candidate)).isFile()) throw new Error("Updater package metadata must be a regular file");
        path = candidate;
        break;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    if (!path) throw new Error(`Missing updater dependency: ${name}`);
    await safeStat(root, path);
    if (visited.has(path)) return;
    visited.add(path);
    const metadata = JSON.parse(await readFile(path, "utf8"));
    if (metadata.name !== name || typeof metadata.version !== "string") throw new Error("Invalid updater dependency identity");
    if (name === "electron-updater" && metadata.version !== pkg.dependencies[name]) throw new Error("Installed updater does not match pinned version");
    const base = dirname(path);
    async function walk(directory) {
      for (const entry of (await readdir(directory)).sort()) {
        if (entry === "node_modules") continue;
        const file = join(directory, entry);
        const info = await safeStat(root, file);
        if (info.isDirectory()) await walk(file);
        else if (!info.isFile()) throw new Error("Updater dependencies must contain regular files");
        else if (shouldCopyDependencyFile(file)) await addFile(file);
      }
    }
    await walk(base);
    for (const child of Object.keys(metadata.dependencies ?? {}).sort()) await dependency(child, path);
  }
  await dependency("electron-updater", pkgPath);
  return { schema: 1, version, digest: hash.digest("hex"), toolset };
}

function deployable(path) {
  const lower = path.toLowerCase();
  return shouldCopyDependencyFile(lower) && !(lower.startsWith(".next/") && (/^\.next\/(?:cache|trace|trace-build)(?:\/|$)/.test(lower) || lower.endsWith(".nft.json")));
}

async function serverLayout(root) {
  const files = [];
  async function walk(path) {
    const name = portable(relative(root, path));
    if (!deployable(name)) return;
    const info = await safeStat(root, path);
    if (info.isDirectory()) {
      for (const entry of (await readdir(path)).sort()) await walk(join(path, entry));
    } else {
      if (!info.isFile()) throw new Error("Application files must be regular files");
      files.push({ path: name, size: info.size, sha256: await hashFile(path) });
      if (files.length > LIMITS.files) throw new Error("Too many application files");
    }
  }
  for (const name of ROOTS) if (await exists(join(root, name))) await walk(join(root, name));
  const layout = { schema: 1, files };
  return validateLayout(layout, { layout: { fileCount: files.length, bytes: files.reduce((sum, file) => sum + file.size, 0) } });
}

async function createArchive({ serverRoot, archivePath, listPath, zipExecutable }) {
  if (typeof zipExecutable !== "string" || !isAbsolute(zipExecutable) || !(await lstat(zipExecutable)).isFile()) throw new Error("An explicit local 7za executable is required");
  await new Promise((resolve, reject) => {
    const child = spawn(zipExecutable, ["a", "-tzip", "-mx=5", "-scsUTF-8", "-spd", archivePath, `@${listPath}`], { cwd: serverRoot, stdio: "inherit", windowsHide: true, shell: false });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`Application ZIP failed (${code ?? signal})`)));
  });
}

export async function prepareApplicationRelease({ serverRoot, output, version, shell, signing, zipExecutable, createZip = createArchive }) {
  if (!isStableVersion(version)) throw new Error("A stable application version is required");
  validateShell(shell);
  serverRoot = await regularRoot(serverRoot);
  await safeStat(serverRoot, join(serverRoot, "package.json"));
  if (JSON.parse(await readFile(join(serverRoot, "package.json"), "utf8")).version !== version) throw new Error("Server package version does not match release version");
  const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/releases\/latest\/download\/desktop-update-manifest\.json$/.exec(signing?.config?.manifestUrl);
  if (!match || [match[1], match[2]].some((part) => part === "." || part === "..")) throw new Error("Invalid GitHub latest update manifest URL");
  if (signing.privateKey?.asymmetricKeyType !== "ed25519" || signing.config.publicKey !== createPublicKey(signing.privateKey).export({ format: "pem", type: "spki" }).toString()) throw new Error("Application signing key does not match config");
  output = resolve(output);
  if (inside(serverRoot, output)) throw new Error("Application output must be outside server root");
  const archiveName = `Weclio-${version}-x64-Application.zip`;
  const layoutName = `Weclio-${version}-x64-Application.files.json`;
  const names = [archiveName, layoutName, APPLICATION_MANIFEST_NAME];
  await mkdir(output, { recursive: true });
  output = await regularRoot(output);
  if (inside(serverRoot, output)) throw new Error("Application output must be outside server root");
  for (const name of names) if (await exists(join(output, name))) throw new Error(`Application artifact already exists: ${name}`);
  const layout = await serverLayout(serverRoot);
  const layoutBytes = Buffer.from(JSON.stringify(layout) + "\n");
  if (layoutBytes.length > LIMITS.layoutBytes) throw new Error("Application layout is too large");
  const stage = await mkdtemp(join(output, ".application-"));
  try {
    const archivePath = join(stage, archiveName);
    const listPath = join(stage, "files.txt");
    await writeFile(listPath, layout.files.map((file) => file.path).join("\n") + "\n", { flag: "wx" });
    await createZip({ serverRoot, archivePath, listPath, zipExecutable, files: layout.files.map((file) => file.path) });
    const info = await lstat(archivePath);
    if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > LIMITS.archiveBytes) throw new Error("Invalid application archive");
    // ZIP 前后复核文件快照；改变的输入绝不能签发。
    if (JSON.stringify(await serverLayout(serverRoot)) !== JSON.stringify(layout)) throw new Error("Application files changed while archiving");
    const base = `https://github.com/${match[1]}/${match[2]}/releases/download/desktop-v${version}/`;
    const body = {
      schema: 1, type: "weclio-application", version, platform: "win32", arch: "x64",
      shell: { version: shell.version, digest: shell.digest }, toolset: shell.toolset,
      archive: { url: base + archiveName, size: info.size, sha512: await hashFile(archivePath, "sha512", "base64") },
      layout: { url: base + layoutName, size: layoutBytes.length, sha512: digest(layoutBytes, "sha512", "base64"), fileCount: layout.files.length, bytes: layout.files.reduce((sum, file) => sum + file.size, 0) },
    };
    const payload = Buffer.from(JSON.stringify(body));
    const manifestEnvelope = { payload: payload.toString("base64"), signature: sign(null, payload, signing.privateKey).toString("base64") };
    const verified = verifyApplicationManifest(manifestEnvelope, signing.config.publicKey);
    validateLayout(JSON.parse(layoutBytes.toString("utf8")), verified);
    await writeFile(join(stage, layoutName), layoutBytes, { flag: "wx" });
    await writeFile(join(stage, APPLICATION_MANIFEST_NAME), JSON.stringify(manifestEnvelope, null, 2) + "\n", { flag: "wx" });
    // 清单最后落盘；排他复制不覆盖任何已发布产物。
    for (const name of names) await copyFile(join(stage, name), join(output, name), constants.COPYFILE_EXCL);
    return { manifestPath: join(output, APPLICATION_MANIFEST_NAME), archivePath: join(output, archiveName), layoutPath: join(output, layoutName), files: names, manifestEnvelope };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

// 只生成业务包产物，不提交、不打标签、不上传；签名私钥仍在仓库外。
async function main() {
  const args = process.argv.slice(2);
  const value = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
  const root = fileURLToPath(new URL("../", import.meta.url));
  const serverRoot = value("--server");
  const output = value("--output");
  const zipExecutable = value("--zip");
  // 可选 --shell 指定已安装壳的描述符；默认取本次构建生成的壳描述符。
  const shellFile = value("--shell") ?? join(root, "build/desktop/shell.json");
  const expectedLength = value("--shell") ? 8 : 6;
  const flags = new Set(["--server", "--output", "--zip", "--shell"]);
  const wellFormed = args.every((arg, index) => index % 2 === 0 ? flags.has(arg) : typeof arg === "string" && arg.length > 0) && new Set(args.filter((_arg, index) => index % 2 === 0)).size === args.length / 2;
  if (args.length !== expectedLength || !wellFormed || !serverRoot || !output || !zipExecutable || !isAbsolute(serverRoot) || !isAbsolute(output) || !isAbsolute(zipExecutable) || !isAbsolute(shellFile)) {
    throw new Error("用法: node electron/application-release.mjs --server <绝对目录> --output <绝对目录> --zip <7za 绝对路径> [--shell <壳描述符绝对路径>]");
  }
  const version = await readFile(join(root, "package.json"), "utf8").then((text) => JSON.parse(text).version);
  const shell = JSON.parse(await readFile(shellFile, "utf8"));
  const signing = await readReleaseSigning({ root });
  const result = await prepareApplicationRelease({ serverRoot, output, version, shell, signing, zipExecutable });
  console.log(`业务包: ${result.archivePath}\n文件清单: ${result.layoutPath}\n签名清单: ${result.manifestPath}\n未上传；需手动附加到 desktop-v${version} 发布。`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(`[desktop-application] ${error.message}`); process.exitCode = 1; });
}
