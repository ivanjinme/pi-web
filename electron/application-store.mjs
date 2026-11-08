import { constants, createReadStream } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { APPLICATION_STARTUP_FILES, compatibleApplication, LIMITS, validateLayout, verifyApplicationManifest } from "./application-manifest.mjs";
const ENVELOPE = "envelope.json";
const LAYOUT = "layout.json";
const RECEIPT = "complete.json";
const TOOL_NAMES = ["git/usr/bin/zipinfo.exe", "git/usr/bin/unzip.exe"];
const HEX_ID = /^[a-f0-9]{64}$/;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const invalid = (message) => new Error(`Invalid prepared application: ${message}`);

async function directory(location) {
  const info = await lstat(location);
  if (!info.isDirectory() || info.isSymbolicLink()) throw invalid(`not a directory: ${location}`);
}

async function regularFile(root, relative) {
  await directory(root);
  const parts = relative.split("/");
  for (let index = 0; index < parts.length; index++) {
    const location = path.join(root, ...parts.slice(0, index + 1));
    const info = await lstat(location);
    if (info.isSymbolicLink() || (index === parts.length - 1 ? !info.isFile() : !info.isDirectory())) {
      throw invalid(`not a regular file: ${relative}`);
    }
    if (index === parts.length - 1) return info;
  }
}

async function hashFile(location, algorithm, encoding, signal) {
  signal?.throwIfAborted();
  const hash = createHash(algorithm);
  let size = 0;
  for await (const chunk of createReadStream(location, { flags: constants.O_RDONLY | (constants.O_NOFOLLOW || 0), signal })) {
    hash.update(chunk);
    size += chunk.length;
  }
  return { size, hash: hash.digest(encoding) };
}

async function checkedFile(root, file, signal) {
  const info = await regularFile(root, file.path);
  if (info.size !== file.size) throw invalid(`file size: ${file.path}`);
  const actual = await hashFile(path.join(root, file.path), "sha256", "hex", signal);
  if (actual.size !== file.size || actual.hash !== file.sha256) throw invalid(`file hash: ${file.path}`);
}

async function artifact(location, expected, signal) {
  if (typeof location !== "string" || !path.isAbsolute(location)) throw invalid("absolute artifact path required");
  const info = await regularFile(path.dirname(location), path.basename(location));
  if (info.size !== expected.size) throw invalid("artifact size");
  const actual = await hashFile(location, "sha512", "base64", signal);
  if (actual.size !== expected.size || actual.hash !== expected.sha512) throw invalid("artifact hash");
}

async function boundedRead(root, relative, maximum) {
  const info = await regularFile(root, relative);
  if (info.size > maximum) throw invalid(`metadata size: ${relative}`);
  const bytes = await readFile(path.join(root, relative));
  if (bytes.length > maximum) throw invalid(`metadata size: ${relative}`);
  return bytes;
}

function parse(bytes) {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

function releaseFrom(envelope, key, shell, devFixture) {
  const release = verifyApplicationManifest(envelope, key, devFixture);
  if (!compatibleApplication(release, shell)) {
    const error = invalid("incompatible shell or toolset");
    error.code = "ERR_APPLICATION_INCOMPATIBLE";
    throw error;
  }
  return release;
}

function storePaths(storeRoot, id) {
  if (typeof storeRoot !== "string" || !path.isAbsolute(storeRoot)) throw invalid("absolute storeRoot required");
  if (typeof id !== "string" || !HEX_ID.test(id)) throw invalid("release id");
  const versions = path.join(storeRoot, "versions");
  return { versions, destination: path.join(versions, id) };
}

async function versionMatches(serverRoot, release, files) {
  const expected = files.find((file) => file.path === "package.json");
  const bytes = await boundedRead(serverRoot, "package.json", expected.size);
  if (parse(bytes).version !== release.version) throw invalid("package version");
}

async function readCompleted({ storeRoot, id, key, shell, devFixture = false, signal }) {
  const { versions, destination } = storePaths(storeRoot, id);
  await directory(storeRoot);
  await directory(versions);
  await directory(destination);
  // 只有发布目录本身缺失才是 ENOENT；已存在但缺少元数据的目录必须保留并报损坏。
  try {
    signal?.throwIfAborted();
    const envelope = parse(await boundedRead(destination, ENVELOPE, 2 * LIMITS.manifestBytes));
    const release = releaseFrom(envelope, key, shell, devFixture);
    if (release.id !== id) throw invalid("release identity");
    const bytes = await boundedRead(destination, LAYOUT, LIMITS.layoutBytes);
    if (bytes.length !== release.layout.size || createHash("sha512").update(bytes).digest("base64") !== release.layout.sha512) throw invalid("layout digest");
    const layout = validateLayout(parse(bytes), release);
    const receipt = parse(await boundedRead(destination, RECEIPT, 1024));
    if (Object.keys(receipt).sort().join(",") !== "bytes,fileCount,id,layoutSha512,schema" || receipt.schema !== 1 || receipt.id !== id || receipt.layoutSha512 !== release.layout.sha512 || receipt.fileCount !== release.layout.fileCount || receipt.bytes !== release.layout.bytes) throw invalid("completion receipt");
    const serverRoot = path.join(destination, "server");
    await directory(serverRoot);
    for (const name of APPLICATION_STARTUP_FILES) await checkedFile(serverRoot, layout.files.find((file) => file.path === name), signal);
    await versionMatches(serverRoot, release, layout.files);
    return { id, version: release.version, serverRoot, envelope };
  } catch (error) {
    if (error.code === "ENOENT") throw invalid("incomplete existing version");
    throw error;
  }
}

export function readPreparedApplication(options) {
  return readCompleted(options);
}

function prefixes(files) {
  const directories = new Set();
  for (const file of files) {
    const parts = file.path.split("/");
    parts.pop();
    while (parts.length) {
      directories.add(parts.join("/"));
      parts.pop();
    }
  }
  return directories;
}

// 仅接受 Info-ZIP 固定 C locale 的长格式，并以独立逐行名称列表交叉核验。
// 无法无歧义解释的输出一律拒绝，不回退到先解压后检查。
export function validateZipListing(longListing, nameListing, layout, archiveSize) {
  const lines = longListing.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (!/^Archive:  .+$/.test(lines.shift() || "")) throw invalid("ZIP listing header");
  const header = /^Zip file size: (\d+) bytes, number of entries: (\d+)$/.exec(lines.shift() || "");
  if (!header || Number(header[1]) !== archiveSize) throw invalid("ZIP listing size");
  const count = Number(header[2]);
  const summary = /^(\d+) files?, (\d+) bytes uncompressed, (\d+) bytes compressed: +[-\d.]+%$/.exec(lines.pop() || "");
  const names = nameListing.replace(/\r\n/g, "\n").split("\n");
  if (names.at(-1) === "") names.pop();
  if (!summary || Number(summary[1]) !== count || lines.length !== count || names.length !== count) throw invalid("ZIP listing count");
  const files = new Map(layout.files.map((file) => [file.path, file]));
  const directories = prefixes(layout.files);
  const seen = new Set();
  let bytes = 0;
  let compressed = 0;
  for (let index = 0; index < lines.length; index++) {
    const row = /^([?d-][rwxstST-]{9}) +\d+\.\d+ +(\w+) +(\d+) +([bt][-xlX]) +(\d+) +(stor|def[NSFX]) +(\d{8}\.\d{6}) (.+)$/.exec(lines[index]);
    if (!row || row[8] !== names[index]) throw invalid("ZIP member format or type");
    const [, mode, origin, size, , packed, , , name] = row;
    if (mode[0] === "?" && origin !== "fat") throw invalid("ZIP unknown file type");
    const isDirectory = mode[0] === "d";
    const member = isDirectory && name.endsWith("/") ? name.slice(0, -1) : name;
    // layout 已拒绝 Windows 别名；精确成员匹配同时拒绝路径穿越、ADS 和反斜杠。
    if (seen.has(member) || (isDirectory ? !name.endsWith("/") || !directories.has(member) || Number(size) !== 0 : !files.has(member) || Number(size) !== files.get(member).size)) throw invalid(`ZIP unexpected or duplicate member: ${name}`);
    seen.add(member);
    bytes += Number(size);
    compressed += Number(packed);
  }
  if (layout.files.some((file) => !seen.has(file.path)) || bytes !== Number(summary[2]) || compressed !== Number(summary[3]) || bytes !== layout.files.reduce((sum, file) => sum + file.size, 0)) throw invalid("ZIP missing members or totals");
}

async function verifiedTools(toolsRoot, manifest, release, signal) {
  if (typeof toolsRoot !== "string" || !path.isAbsolute(toolsRoot) || !manifest || manifest.schema !== 1 || !Array.isArray(manifest.files) || manifest.id !== release.toolset) throw invalid("toolset manifest");
  const files = manifest.files.map((file) => ({ path: file.path, size: file.size, sha256: file.sha256 })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (digest(JSON.stringify({ schema: 1, files })) !== manifest.id) throw invalid("toolset digest");
  for (const name of TOOL_NAMES) {
    const matches = files.filter((file) => file.path === name);
    if (matches.length !== 1) throw invalid(`missing tool: ${name}`);
    await checkedFile(toolsRoot, matches[0], signal);
  }
  return TOOL_NAMES.map((name) => path.join(toolsRoot, name));
}

function execute(executable, args, signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    execFile(executable, args, {
      windowsHide: true, shell: false, signal, timeout: 300_000, maxBuffer: 64 * 1024 * 1024,
      encoding: "utf8", env: { ...process.env, LC_ALL: "C", LANG: "C", UNZIP: "", UNZIPOPT: "", ZIPINFO: "", ZIPINFOOPT: "" },
    }, (error, stdout) => error ? reject(error) : resolve(stdout));
  });
}

async function verifyExtracted(serverRoot, layout, signal, progress) {
  const files = new Map(layout.files.map((file) => [file.path, file]));
  const directories = prefixes(layout.files);
  let completedBytes = 0;
  let completedFiles = 0;
  async function visit(relative) {
    signal?.throwIfAborted();
    const location = path.join(serverRoot, relative);
    const info = await lstat(location);
    if (info.isSymbolicLink()) throw invalid(`linked extracted path: ${relative}`);
    if (info.isDirectory()) {
      if (relative && !directories.has(relative)) throw invalid(`extra extracted directory: ${relative}`);
      for (const name of await readdir(location)) await visit(relative ? `${relative}/${name}` : name);
    } else if (info.isFile() && files.has(relative)) {
      const file = files.get(relative);
      await checkedFile(serverRoot, file, signal);
      completedBytes += file.size;
      completedFiles++;
      progress("verifying", completedBytes, completedFiles);
    } else {
      throw invalid(`extra extracted file or type: ${relative}`);
    }
  }
  await visit("");
  if (completedFiles !== layout.files.length) throw invalid("missing extracted files");
}

export async function prepareApplication({ storeRoot, archivePath, layoutPath, envelope, key, shell, toolsRoot, toolsetManifest, signal, onProgress, devFixture = false }) {
  const release = releaseFrom(envelope, key, shell, devFixture);
  const { versions, destination } = storePaths(storeRoot, release.id);
  const progress = (phase, completedBytes = 0, completedFiles = 0) => {
    signal?.throwIfAborted();
    onProgress?.({ phase, completedBytes, totalBytes: release.layout.bytes, completedFiles, totalFiles: release.layout.fileCount });
    signal?.throwIfAborted();
  };
  signal?.throwIfAborted();
  try {
    const existing = await readCompleted({ storeRoot, id: release.id, key, shell, devFixture, signal });
    progress("ready", release.layout.bytes, release.layout.fileCount);
    return existing;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await artifact(archivePath, release.archive, signal);
  await artifact(layoutPath, release.layout, signal);
  const layoutBytes = await boundedRead(path.dirname(layoutPath), path.basename(layoutPath), LIMITS.layoutBytes);
  if (layoutBytes.length !== release.layout.size || createHash("sha512").update(layoutBytes).digest("base64") !== release.layout.sha512) throw invalid("layout digest");
  const layout = validateLayout(parse(layoutBytes), release);
  const [zipinfo, unzip] = await verifiedTools(toolsRoot, toolsetManifest, release, signal);
  const longListing = await execute(zipinfo, ["-l", "-T", archivePath], signal);
  const names = await execute(zipinfo, ["-1", archivePath], signal);
  validateZipListing(longListing, names, layout, release.archive.size);
  // 校验本地头、CRC 和中央目录一致性，不在此阶段落地任何 ZIP 成员。
  await execute(unzip, ["-tqq", archivePath], signal);
  await mkdir(storeRoot, { recursive: true });
  await directory(storeRoot);
  await mkdir(versions, { recursive: true });
  await directory(versions);
  const staging = await mkdtemp(path.join(versions, ".stage-"));
  try {
    const serverRoot = path.join(staging, "server");
    await mkdir(serverRoot);
    progress("extracting");
    await execute(unzip, ["-q", "-n", archivePath, "-d", serverRoot], signal);
    progress("verifying");
    await verifyExtracted(serverRoot, layout, signal, progress);
    await versionMatches(serverRoot, release, layout.files);
    await writeFile(path.join(staging, ENVELOPE), JSON.stringify(envelope), { flag: "wx" });
    await writeFile(path.join(staging, LAYOUT), layoutBytes, { flag: "wx" });
    await writeFile(path.join(staging, RECEIPT), JSON.stringify({ schema: 1, id: release.id, layoutSha512: release.layout.sha512, fileCount: release.layout.fileCount, bytes: release.layout.bytes }), { flag: "wx" });
    signal?.throwIfAborted();
    // 先检查已有目录，禁止把损坏的空目录作为 rename 的可覆盖目标。
    try {
      await lstat(destination);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      try {
        await rename(staging, destination);
      } catch (race) {
        if (!["EEXIST", "ENOTEMPTY", "EPERM"].includes(race.code)) throw race;
      }
    }
    const record = await readCompleted({ storeRoot, id: release.id, key, shell, devFixture, signal });
    progress("ready", release.layout.bytes, release.layout.fileCount);
    return record;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
