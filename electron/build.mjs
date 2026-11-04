import { cp, mkdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const server = join(root, "build", "desktop", "server");
const require = createRequire(import.meta.url);

function run(command, args, cwd) {
  // 从正在运行的 Next 服务内触发构建时，不继承其开发编译状态。
  const env = { ...process.env, NODE_ENV: "production" };
  for (const key of Object.keys(env)) {
    if (key === "TURBOPACK" || key === "NEXT_RUNTIME" || key.startsWith("__NEXT_")) delete env[key];
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: "inherit", windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`构建命令失败 (${code ?? signal}): ${args.join(" ")}`)));
  });
}

try {
  if (process.platform !== "win32" || process.arch !== "x64") throw new Error("桌面构建目前仅支持 Windows x64。");
  for (const file of ["git/bin/bash.exe", "git/cmd/git.exe", "git/LICENSE.txt", "tools/rg.exe", "tools/fd.exe"]) {
    if (!existsSync(join(root, "resources/runtime/win-x64", file))) throw new Error(`请先准备 resources/runtime/win-x64/${file}`);
  }
  // 复用项目 Electron 分发文件；首次缺失时交由 Electron 自身的安装逻辑准备。
  require("electron");
  const npm = process.env.npm_execpath ?? join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
  // 使用锁定后已经安装的生产依赖，不重新下载，也不让 builder 按 Electron ABI 重建服务端依赖。
  const listing = execFileSync(process.execPath, [npm, "ls", "--omit=dev", "--all", "--parseable"], { cwd: root, encoding: "utf8", windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  const packages = [];
  for (const directory of [...new Set(listing.trim().split(/\r?\n/))].sort((a, b) => a.length - b.length)) {
    const name = relative(root, directory);
    if (!name) continue;
    if (!name.startsWith(`node_modules${sep}`)) throw new Error(`不打包项目外部链接依赖: ${directory}`);
    if (!packages.some((parent) => directory.startsWith(parent + sep))) packages.push(directory);
  }
  await rm(server, { recursive: true, force: true, maxRetries: 3 });
  await mkdir(server, { recursive: true });
  for (const name of ["app", "components", "hooks", "lib", "public", "instrumentation.ts", "proxy.ts", "postcss.config.mjs", "tailwind.config.ts", "tsconfig.json", "next-env.d.ts", "package.json", "LICENSE"]) {
    await cp(join(root, name), join(server, name), { recursive: true });
  }
  await cp(join(root, "electron", "packages.mjs"), join(server, "desktop-packages.mjs"));
  // 生成 JS 配置，发布服务无需安装 TypeScript；不复制 .env 或用户配置。
  const config = await readFile(join(root, "next.config.ts"), "utf8");
  await writeFile(join(server, "next.config.js"), ts.transpileModule(config, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText + "\nmodule.exports = exports.default;\n");
  const modules = join(server, "node_modules");
  await symlink(join(root, "node_modules"), modules, "junction");
  try {
    console.log("[desktop] 在 build/desktop/server 构建 Web，不修改开发 .next。");
    await run(process.execPath, [require.resolve("next/dist/bin/next"), "build", server, "--webpack"], server);
  } finally {
    // 先删除 junction，绝不能递归清理源项目的 node_modules。
    await unlink(modules);
  }
  console.log(`[desktop] 复制 ${packages.length} 个生产依赖目录。`);
  for (let index = 0; index < packages.length; index += 8) {
    await Promise.all(packages.slice(index, index + 8).map((directory) => cp(directory, join(server, relative(root, directory)), { recursive: true, dereference: true })));
  }
  await rm(join(server, ".next", "cache"), { recursive: true, force: true });
  console.log("[desktop] 生产服务准备完成: build/desktop/server");
} catch (error) {
  console.error(`[desktop] ${error.message}`);
  process.exitCode = 1;
}
