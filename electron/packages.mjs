import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";

const names = ["@weclio/plugins", "weclio-cli"];
const sourceOf = (entry) => typeof entry === "string" ? entry : entry.source;

async function prepareUserPackages(root, agentDir) {
  const target = join(agentDir, "npm");
  const installed = Object.fromEntries(names.map((name) => [name, join(target, "node_modules", name)]));
  // 首装中断后允许重试，但不覆盖已有的 npm 包环境。
  if (existsSync(target)) {
    const file = join(target, "package.json");
    const manifest = existsSync(file) ? JSON.parse(await readFile(file, "utf8")) : {};
    if (names.some((name) => !manifest.dependencies?.[name] || !existsSync(join(installed[name], "package.json")))) {
      throw new Error("已有 Pi npm 目录缺少首装资源；未覆盖现有包。");
    }
    return installed;
  }
  const modules = join(root, "node_modules");
  const queue = names.map((name) => join(modules, name));
  const manifests = new Map();
  // 仅复制两个包及 CLI 的实际生产依赖闭包，不复制宿主 SDK/个人数据。
  for (const directory of queue) {
    if (manifests.has(directory)) continue;
    const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
    manifests.set(directory, manifest);
    const require = createRequire(join(directory, "package.json"));
    for (const name of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies })) {
      const file = require.resolve.paths(name).map((base) => join(base, name, "package.json")).find(existsSync);
      if (!file && name in (manifest.optionalDependencies ?? {})) continue;
      if (!file || !file.startsWith(modules + sep)) throw new Error(`内置包缺少生产依赖: ${name}`);
      queue.push(dirname(file));
    }
  }
  const temporary = `${target}.${process.pid}.tmp`;
  await mkdir(temporary, { recursive: true });
  try {
    const copied = [];
    for (const directory of [...manifests.keys()].sort((a, b) => a.length - b.length)) {
      if (copied.some((parent) => directory.startsWith(parent + sep))) continue;
      await cp(directory, join(temporary, "node_modules", relative(modules, directory)), { recursive: true, dereference: true });
      copied.push(directory);
    }
    // 两个包都声明为依赖，后续 npm 更新其中一个时不会把另一个当作多余包清掉。
    const dependencies = Object.fromEntries(names.map((name) => [name, manifests.get(join(modules, name)).version]));
    await writeFile(join(temporary, "package.json"), JSON.stringify({ name: "pi-extensions", private: true, dependencies }, null, 2) + "\n");
    await writeFile(join(temporary, ".gitignore"), "*\n!.gitignore\n");
    await rename(temporary, target);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  return installed;
}

export async function initializeDesktopPackages(root, agentDir = getAgentDir()) {
  const receiptFile = join(agentDir, "weclio-desktop-packages.json");
  // 只做一次首装；之后完全交给 Pi/npm，桌面升级不再读取或覆盖这些包。
  if (existsSync(receiptFile)) return;
  const settings = SettingsManager.create(homedir(), agentDir, { projectTrusted: false });
  const checkErrors = () => {
    const errors = settings.drainErrors();
    if (errors.length) throw new Error(`无法初始化内置包，原配置未重置: ${errors.map(({ error }) => error.message).join("; ")}`);
  };
  checkErrors();
  // 先验证整包，缺少 CLI 或 skill 时不能留下半套初始化配置。
  for (const name of names) {
    const directory = join(root, "node_modules", name);
    const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
    if (manifest.name !== name) throw new Error(`安装包资源不匹配: ${name}`);
    const files = [
      ...(manifest.pi?.extensions ?? []),
      ...(manifest.pi?.skills ?? []).map((skill) => join(skill, "SKILL.md")),
      ...Object.values(manifest.bin ?? {}),
    ];
    for (const file of files) {
      if (!existsSync(join(directory, file))) throw new Error(`安装包缺少 ${name}/${file}`);
    }
  }
  const installed = await prepareUserPackages(root, agentDir);
  const packages = [...(settings.getGlobalSettings().packages ?? [])];
  let changed = false;
  for (const name of names) {
    const source = `npm:${name}`;
    if (packages.some((entry) => sourceOf(entry) === source)) continue;
    packages.push(source);
    changed = true;
  }
  if (changed) {
    settings.setPackages(packages);
    await settings.flush();
    checkErrors();
  }
  const temporary = `${receiptFile}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify({ initialized: names }, null, 2) + "\n");
  await rename(temporary, receiptFile);
  console.log("[desktop] 内置包首装完成，后续由 Pi/npm 独立管理。");
  return installed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await initializeDesktopPackages(dirname(fileURLToPath(import.meta.url)));
}
