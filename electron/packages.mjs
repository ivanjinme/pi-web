import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

// 与 Pi 共用其已有的锁依赖及锁路径，不另建一套配置锁协议。
const { lock } = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"))("proper-lockfile");
const names = ["@weclio/plugins", "weclio-cli"];
const sourceOf = (entry) => typeof entry === "string" ? entry : entry.source;

async function readJson(file) {
  if (!existsSync(file)) return {};
  try {
    const value = JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, ""));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("必须是 JSON 对象");
    return value;
  } catch (error) {
    throw new Error(`无法读取 ${file}，原配置未重置: ${error.message}`);
  }
}

async function writeJson(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + "\n");
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function seedPackage(root, destination, name) {
  if (existsSync(destination)) {
    const manifest = await readJson(join(destination, "package.json"));
    if (manifest.name !== name || typeof manifest.version !== "string") throw new Error(`已有 ${name} 包不完整；未覆盖，请通过 Pi/npm 修复。`);
    return manifest.version;
  }
  const modules = join(root, "node_modules");
  const entry = join(modules, name);
  const queue = [entry];
  const manifests = new Map();
  for (const directory of queue) {
    if (manifests.has(directory)) continue;
    const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
    manifests.set(directory, manifest);
    const require = createRequire(join(directory, "package.json"));
    for (const dependency of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies })) {
      const file = require.resolve.paths(dependency).map((base) => join(base, dependency, "package.json")).find(existsSync);
      if (!file && dependency in (manifest.optionalDependencies ?? {})) continue;
      if (!file || !file.startsWith(modules + sep)) throw new Error(`内置包缺少生产依赖: ${dependency}`);
      queue.push(dirname(file));
    }
  }
  await mkdir(dirname(destination), { recursive: true });
  const temporary = await mkdtemp(join(dirname(destination), `.weclio-desktop-${basename(name)}-`));
  try {
    await cp(entry, temporary, { recursive: true, dereference: true });
    const copied = [entry];
    // 新包的依赖放在包内，不能覆盖用户 npm 环境中同名、不同版本的依赖。
    for (const directory of [...manifests.keys()].sort((a, b) => a.length - b.length)) {
      if (copied.some((parent) => directory === parent || directory.startsWith(parent + sep))) continue;
      await cp(directory, join(temporary, "node_modules", relative(modules, directory)), { recursive: true, dereference: true });
      copied.push(directory);
    }
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  return manifests.get(entry).version;
}

export async function initializeDesktopPackages(root, agentDir = getAgentDir()) {
  const receiptFile = join(agentDir, "weclio-desktop-packages.json");
  // 只做一次首装；之后完全交给 Pi/npm，桌面升级不恢复用户删除的包。
  if (existsSync(receiptFile)) return;
  await mkdir(agentDir, { recursive: true });
  const settingsFile = join(agentDir, "settings.json");
  const lockOptions = { realpath: false, retries: { retries: 60, factor: 1, minTimeout: 250, maxTimeout: 250 } };
  const release = await lock(receiptFile, lockOptions);
  try {
    if (existsSync(receiptFile)) return;
    // 预检也遵守 Pi 配置锁，避免读到其他进程尚未写完的 JSON。
    const releasePreflight = await lock(settingsFile, lockOptions);
    try {
      const settings = await readJson(settingsFile);
      if (settings.packages !== undefined && !Array.isArray(settings.packages)) throw new Error("packages 配置必须是数组，原配置未重置。");
    } finally {
      await releasePreflight();
    }
    const target = join(agentDir, "npm");
    const manifestFile = join(target, "package.json");
    await readJson(manifestFile);
    // 缺少整包资源时，在写入用户包或配置前失败。
    for (const name of names) {
      const directory = join(root, "node_modules", name);
      const bundled = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
      if (bundled.name !== name) throw new Error(`安装包资源不匹配: ${name}`);
      const files = [
        ...(bundled.pi?.extensions ?? []),
        ...(bundled.pi?.skills ?? []).map((skill) => join(skill, "SKILL.md")),
        ...Object.values(bundled.bin ?? {}),
      ];
      for (const file of files) if (!existsSync(join(directory, file))) throw new Error(`安装包缺少 ${name}/${file}`);
    }
    const installed = {};
    const versions = {};
    console.log("[desktop] 正在准备内置扩展与技能，请稍候。");
    for (const name of names) {
      installed[name] = join(target, "node_modules", name);
      versions[name] = await seedPackage(root, installed[name], name);
    }
    // 拷贝结束后重读清单，保留其他依赖、版本和用户字段。
    const manifest = await readJson(manifestFile);
    const dependencies = { ...manifest.dependencies };
    for (const name of names) dependencies[name] ??= versions[name];
    if (JSON.stringify(manifest.dependencies) !== JSON.stringify(dependencies)) {
      await writeJson(manifestFile, { name: "pi-extensions", private: true, ...manifest, dependencies });
    }
    if (!existsSync(join(target, ".gitignore"))) await writeFile(join(target, ".gitignore"), "*\n!.gitignore\n");
    // 合并写入时重新获取 Pi 配置锁，耗时拷贝期间不阻塞其他进程的设置更新。
    const releaseSettings = await lock(settingsFile, lockOptions);
    try {
      const current = await readJson(settingsFile);
      if (current.packages !== undefined && !Array.isArray(current.packages)) throw new Error("packages 配置必须是数组，原配置未重置。");
      const packages = [...(current.packages ?? [])];
      for (const name of names) {
        const source = `npm:${name}`;
        if (!packages.some((entry) => sourceOf(entry) === source || sourceOf(entry)?.startsWith(`${source}@`))) packages.push(source);
      }
      if (packages.length !== (current.packages ?? []).length) await writeJson(settingsFile, { ...current, packages });
    } finally {
      await releaseSettings();
    }
    await writeJson(receiptFile, { initialized: names });
    console.log("[desktop] 内置包首装完成，后续由 Pi/npm 独立管理。");
    return installed;
  } finally {
    await release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await initializeDesktopPackages(dirname(fileURLToPath(import.meta.url)));
}
