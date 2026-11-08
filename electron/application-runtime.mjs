import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { isStableVersion } from "./application-manifest.mjs";
import { createApplicationSelection, resolveApplicationStore } from "./application-selection.mjs";
import { updateKey, updateUrl } from "./update-signature.mjs";

const METADATA_LIMIT = 65536;
const TOOLSET_LIMIT = 16 * 1024 * 1024;
const hash = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

async function readJson(filename, maximum) {
  const info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maximum) throw new Error(`Invalid application runtime metadata file: ${filename}`);
  const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > maximum || opened.dev !== info.dev || opened.ino !== info.ino) throw new Error(`Application runtime metadata changed: ${filename}`);
    const chunks = [];
    let total = 0;
    while (true) {
      const buffer = Buffer.alloc(Math.min(65536, maximum - total + 1));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > maximum) throw new Error(`Application runtime metadata is too large: ${filename}`);
      chunks.push(buffer.subarray(0, bytesRead));
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, total)));
  } finally {
    await handle.close();
  }
}

function checkedShell(value, shellVersion) {
  const keys = ["schema", "version", "digest", "toolset"];
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))
    || value.schema !== 1 || !isStableVersion(value.version) || value.version !== shellVersion
    || !hash(value.digest) || !hash(value.toolset)) throw new Error("Invalid desktop shell descriptor or shellVersion mismatch");
  return value;
}

function checkedToolset(manifest, shell) {
  if (!manifest || manifest.schema !== 1 || !hash(manifest.id) || manifest.id !== shell.toolset
    || !Array.isArray(manifest.files) || manifest.files.length === 0) throw new Error("Invalid application runtime toolset manifest");
  const files = manifest.files.map((file) => {
    if (!file || typeof file.path !== "string" || !file.path || !Number.isSafeInteger(file.size) || file.size < 0 || !hash(file.sha256)) {
      throw new Error("Invalid application runtime toolset file metadata");
    }
    return { path: file.path, size: file.size, sha256: file.sha256 };
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (createHash("sha256").update(JSON.stringify({ schema: 1, files })).digest("hex") !== manifest.id) {
    throw new Error("Application runtime toolset manifest id mismatch");
  }
  // 完整路径约束及工具文件验证由 resolveDesktopTools 在实际准备时负责。
  return manifest;
}

export async function createApplicationRuntime({ resourcesPath, localAppData, profilePath, shellVersion, toolsRoot, readPrepared } = {}) {
  let descriptor;
  try {
    descriptor = await readJson(path.join(resourcesPath ?? "", "desktop-shell.json"), METADATA_LIMIT);
  } catch (error) {
    // 旧版安装没有 shell 描述符，不要求新版参数，也不读取开发环境配置。
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (typeof resourcesPath !== "string" || !path.isAbsolute(resourcesPath)
    || typeof profilePath !== "string" || !path.isAbsolute(profilePath)
    || typeof toolsRoot !== "string" || !path.isAbsolute(toolsRoot)) {
    throw new Error("Application runtime requires absolute resourcesPath, profilePath and toolsRoot");
  }
  const shell = checkedShell(descriptor, shellVersion);
  const installed = await readJson(path.join(resourcesPath, "desktop-update.json"), METADATA_LIMIT);
  const config = { manifestUrl: updateUrl(installed?.manifestUrl), key: updateKey(installed?.publicKey), devFixture: false };
  const toolsetManifest = checkedToolset(await readJson(path.join(resourcesPath, "desktop-toolset.json"), TOOLSET_LIMIT), shell);
  const storeRoot = await resolveApplicationStore({ resourcesPath, localAppData });
  const selection = createApplicationSelection({
    storeRoot, selectionRoot: path.join(profilePath, "application-selection"),
    bundledRoot: path.join(resourcesPath, "server"), bundledVersion: shell.version,
    key: config.key, shell, readPrepared,
  });
  return { shell, config, toolsetManifest, storeRoot, toolsRoot, selection };
}
