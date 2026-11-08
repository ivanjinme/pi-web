import { existsSync } from "node:fs";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { prepareApplicationRelease } from "./application-release.mjs";
import { buildReleaseIndex } from "./release-index.mjs";
import { readShellBaseline } from "./release-baseline.mjs";
import { readReleaseSigning } from "./update-release.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit", windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`命令失败 (${code ?? signal}): ${args.join(" ")}`)));
  });
}

// 复用 electron-builder 缓存的 7za，不新增依赖，也不依赖用户 PATH。
async function find7za() {
  const cache = join(process.env.LOCALAPPDATA ?? "", "electron-builder", "Cache");
  if (!existsSync(cache)) throw new Error("未找到 electron-builder 缓存；请先运行一次 npm run release:desktop");
  for (const entry of await readdir(cache)) {
    if (!entry.startsWith("7zip@")) continue;
    for (const variant of await readdir(join(cache, entry))) {
      const candidate = join(cache, entry, variant, "bin", "7za.exe");
      if (existsSync(candidate)) return candidate;
    }
  }
  throw new Error("未找到 7za.exe；请先运行一次 npm run release:desktop 以准备打包工具");
}

async function main() {
  if (process.argv.length !== 2) throw new Error("用法: npm run release:desktop:app（不接受参数）");
  if (process.platform !== "win32" || process.arch !== "x64") throw new Error("业务包目前仅支持 Windows x64。");
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const version = pkg.version;
  const baseline = await readShellBaseline({ root });
  if (!baseline) throw new Error("缺少壳基线：请先发布一次壳（npm run release:desktop）");
  await run(process.execPath, [join(root, "electron/build.mjs")]);
  const shell = JSON.parse(await readFile(join(root, "build/desktop/shell.json"), "utf8"));
  // 壳内容变了就必须发壳：业务包会被已安装客户端全部拒绝，不如在这里直接失败。
  if (shell.digest !== baseline.digest || shell.toolset !== baseline.toolset) {
    throw new Error("壳内容已变化：请用 npm run release:desktop 发布壳更新");
  }
  const signing = await readReleaseSigning({ root });
  const dist = join(root, "build/desktop/dist");
  const result = await prepareApplicationRelease({
    serverRoot: join(root, "build/desktop/server"), output: dist, version,
    shell: { ...shell, version: baseline.version }, signing, zipExecutable: await find7za(),
  });
  const index = buildReleaseIndex({ version, shell, installer: { version: baseline.version, tag: `desktop-v${baseline.version}` }, application: { version }, signing });
  const indexPath = join(dist, "desktop-release-index.json");
  await rm(indexPath, { force: true });
  await writeFile(indexPath, JSON.stringify(index, null, 2) + "\n");
  console.log(`\n业务包: ${result.archivePath}\n文件清单: ${result.layoutPath}\n签名清单: ${result.manifestPath}\n发布索引: ${indexPath}\n壳版本: ${baseline.version}（保持不变）\n本命令不会上传。`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(`[desktop-app-release] ${error.message}`); process.exitCode = 1; });
}