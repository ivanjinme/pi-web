import { constants, createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const REQUIRED = ["tools/rg.exe", "tools/fd.exe"];
const RECEIPT = ".desktop-toolset-complete.json";
const digest = (value) => createHash("sha256").update(value).digest("hex");
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const missing = (error) => error.code === "ENOENT";

function validPath(value) {
  return typeof value === "string" && /^tools\//.test(value)
    && value.split("/").every((part) => part && part !== "." && part !== ".."
      && !/[\\<>:"|?*\x00-\x1f\x7f]/.test(part) && !/[. ]$/.test(part)
      && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}

function checkedManifest(manifest) {
  if (!manifest || manifest.schema !== 1 || !Array.isArray(manifest.files) || !/^[a-f0-9]{64}$/.test(manifest.id)) {
    throw new Error("Invalid desktop toolset manifest");
  }
  const seen = new Map();
  const files = manifest.files.map((file) => {
    if (!file || !validPath(file.path) || !Number.isSafeInteger(file.size) || file.size < 0 || !/^[a-f0-9]{64}$/.test(file.sha256)) {
      throw new Error("Invalid desktop toolset file");
    }
    // Windows 大小写别名也适用于目录，不只是完整文件名。
    let prefix = "";
    for (const segment of file.path.split("/")) {
      prefix = prefix ? `${prefix}/${segment}` : segment;
      const folded = prefix.toLowerCase();
      if (seen.has(folded) && seen.get(folded) !== prefix) throw new Error("Case-alias toolset path");
      seen.set(folded, prefix);
    }
    return { path: file.path, size: file.size, sha256: file.sha256 };
  }).sort((a, b) => compare(a.path, b.path));
  const names = new Set(files.map((file) => file.path));
  if (names.size !== files.length || REQUIRED.some((name) => !names.has(name))) throw new Error("Missing or duplicate toolset files");
  for (const file of files) {
    const parts = file.path.split("/");
    parts.pop();
    while (parts.length) {
      if (names.has(parts.join("/"))) throw new Error("Conflicting toolset paths");
      parts.pop();
    }
  }
  const canonical = { schema: 1, files };
  if (digest(JSON.stringify(canonical)) !== manifest.id) throw new Error("Toolset manifest id mismatch");
  return { ...canonical, id: manifest.id };
}

async function regularFile(root, relative) {
  let current = root;
  const parts = relative.split("/");
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    const info = await lstat(current);
    if (info.isSymbolicLink() || (i === parts.length - 1 ? !info.isFile() : !info.isDirectory())) {
      throw new Error(`Not a regular toolset path: ${relative}`);
    }
    if (i === parts.length - 1) return info;
  }
}

async function hashFile(filename, signal) {
  const hash = createHash("sha256");
  const stream = createReadStream(filename, { flags: constants.O_RDONLY | (constants.O_NOFOLLOW || 0), signal });
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

export async function createToolsetManifest(sourceRoot) {
  const root = await realpath(sourceRoot);
  const files = [];
  async function visit(relative) {
    if (relative.includes("/") && !validPath(relative)) throw new Error(`Invalid toolset path: ${relative}`);
    const info = await lstat(path.join(root, relative));
    if (info.isSymbolicLink()) throw new Error(`Linked toolset path: ${relative}`);
    if (info.isDirectory()) {
      for (const name of (await readdir(path.join(root, relative))).sort(compare)) await visit(`${relative}/${name}`);
    } else if (info.isFile()) {
      if (!validPath(relative)) throw new Error(`Invalid toolset path: ${relative}`);
      files.push({ path: relative, size: info.size, sha256: await hashFile(path.join(root, relative)) });
    } else {
      throw new Error(`Not a regular toolset path: ${relative}`);
    }
  }
  for (const directory of ["tools"]) {
    const info = await lstat(path.join(root, directory));
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Invalid toolset directory: ${directory}`);
    await visit(directory);
  }
  files.sort((a, b) => compare(a.path, b.path));
  const canonical = { schema: 1, files };
  return checkedManifest({ ...canonical, id: digest(JSON.stringify(canonical)) });
}

// 尚不存在的路径也解析已有祖先，阻止通过目录别名写回安装目录。
async function realLocation(location) {
  const absolute = path.resolve(location);
  try {
    return await realpath(absolute);
  } catch (error) {
    if (!missing(error)) throw error;
    const parent = path.dirname(absolute);
    if (parent === absolute) throw error;
    return path.join(await realLocation(parent), path.basename(absolute));
  }
}

function inside(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function outsideInstallation(sourceRoot, storeRoot, installationRoot) {
  if (typeof storeRoot !== "string" || !path.isAbsolute(storeRoot)) throw new Error("An absolute shared toolset storeRoot is required");
  const [source, store, installation] = await Promise.all([
    realLocation(sourceRoot), realLocation(storeRoot), installationRoot ? realLocation(installationRoot) : null,
  ]);
  if (inside(store, source) || (installation && inside(store, installation))) throw new Error("Toolset store must be outside the source and installation tree");
  return store;
}

async function completed(destination, manifest, signal) {
  let root;
  try {
    root = await lstat(destination);
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("Invalid existing toolset directory");
  const receiptInfo = await regularFile(destination, RECEIPT);
  if (receiptInfo.size > 1024) throw new Error("Invalid toolset completion receipt");
  const receipt = JSON.parse(await readFile(path.join(destination, RECEIPT), "utf8"));
  if (receipt.schema !== 1 || receipt.id !== manifest.id) throw new Error("Invalid toolset completion receipt");
  for (const name of REQUIRED) {
    const info = await regularFile(destination, name);
    const expected = manifest.files.find((file) => file.path === name);
    if (info.size !== expected.size || await hashFile(path.join(destination, name), signal) !== expected.sha256) {
      throw new Error(`Invalid completed toolset file: ${name}`);
    }
  }
  return true;
}

export async function ensureToolset({ sourceRoot, storeRoot, manifest, signal, onProgress }) {
  const checked = checkedManifest(manifest);
  signal?.throwIfAborted();
  // 标准打包布局中 sourceRoot 是 <installation>/resources/runtime/win-x64。
  const resolvedSource = await realLocation(sourceRoot);
  const installationRoot = path.basename(resolvedSource) === "win-x64" && path.basename(path.dirname(resolvedSource)) === "runtime"
    ? path.resolve(resolvedSource, "../../..") : null;
  const store = await outsideInstallation(sourceRoot, storeRoot, installationRoot);
  const destination = path.join(store, checked.id);
  const totalBytes = checked.files.reduce((sum, file) => sum + file.size, 0);
  let completedBytes = 0;
  let completedFiles = 0;
  const progress = (phase, extra = {}) => {
    signal?.throwIfAborted();
    onProgress?.({ phase, completedBytes, totalBytes, completedFiles, totalFiles: checked.files.length, ...extra });
    signal?.throwIfAborted();
  };
  if (await completed(destination, checked, signal)) {
    completedBytes = totalBytes;
    completedFiles = checked.files.length;
    progress("ready", { reused: true });
    return destination;
  }
  await mkdir(store, { recursive: true });
  await outsideInstallation(sourceRoot, store, installationRoot);
  const temporary = await mkdtemp(path.join(store, `.${checked.id}-`));
  try {
    progress("copying");
    for (const file of checked.files) {
      signal?.throwIfAborted();
      const info = await regularFile(sourceRoot, file.path);
      if (info.size !== file.size) throw new Error(`Toolset size mismatch: ${file.path}`);
      const target = path.join(temporary, file.path);
      await mkdir(path.dirname(target), { recursive: true });
      const hash = createHash("sha256");
      let size = 0;
      const verify = new Transform({ transform(chunk, _encoding, callback) {
        size += chunk.length;
        hash.update(chunk);
        callback(null, chunk);
      } });
      await pipeline(
        createReadStream(path.join(sourceRoot, file.path), { flags: constants.O_RDONLY | (constants.O_NOFOLLOW || 0) }),
        verify, createWriteStream(target, { flags: "wx", mode: info.mode & 0o777 }), { signal },
      );
      if (size !== file.size || hash.digest("hex") !== file.sha256) throw new Error(`Toolset hash mismatch: ${file.path}`);
      completedBytes += size;
      completedFiles++;
      progress("copying", { path: file.path });
    }
    await writeFile(path.join(temporary, RECEIPT), JSON.stringify({ schema: 1, id: checked.id }), { flag: "wx" });
    signal?.throwIfAborted();
    let reused = false;
    try {
      await rename(temporary, destination);
    } catch (error) {
      if (!["EEXIST", "ENOTEMPTY", "EPERM"].includes(error.code)) throw error;
      // 并发赢家必须完整有效；验证失败时保留原始发布错误。
      const winner = await completed(destination, checked, signal).catch(() => false);
      if (!winner) throw error;
      reused = true;
    }
    progress("ready", { reused });
    return destination;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function resolveDesktopTools({ resourcesPath, storeRoot, storeBase, signal, onProgress }) {
  const sourceRoot = path.join(resourcesPath, "runtime", "win-x64");
  let contents;
  try {
    contents = await readFile(path.join(resourcesPath, "desktop-toolset.json"), "utf8");
  } catch (error) {
    if (missing(error)) return sourceRoot;
    throw error;
  }
  const manifest = JSON.parse(contents);
  const installationRoot = path.dirname(await realLocation(resourcesPath));
  if (storeRoot === undefined) {
    if (typeof storeBase !== "string" || !path.isAbsolute(storeBase)) {
      throw new Error("An absolute shared toolset storeBase is required when storeRoot is absent");
    }
    const source = await realLocation(sourceRoot);
    // 自定义安装可能占用首选共享目录；只回退到安装树外的固定候选。
    for (const candidate of [path.join(storeBase, "Weclio", "toolsets"), path.join(storeBase, "Weclio-toolsets")]) {
      const canonical = await realLocation(candidate);
      if (!inside(canonical, installationRoot) && !inside(canonical, source)) {
        storeRoot = canonical;
        break;
      }
    }
    if (storeRoot === undefined) {
      throw new Error("Shared toolset storage overlaps the installation. Please reinstall Weclio in a dedicated installation directory, not directly in storeBase.");
    }
  }
  await outsideInstallation(sourceRoot, storeRoot, installationRoot);
  return ensureToolset({ sourceRoot, storeRoot, manifest, signal, onProgress });
}
