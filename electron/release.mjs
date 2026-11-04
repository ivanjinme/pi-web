import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import nodeVersion from "../bin/node-version.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const inputs = ["app", "components", "hooks", "lib", "public", "instrumentation.ts", "proxy.ts", "postcss.config.mjs", "tailwind.config.ts", "tsconfig.json", "next.config.ts", "package.json", "package-lock.json", "LICENSE", "electron/build.mjs", "electron/packages.mjs"];

export async function fingerprint(base, paths = inputs) {
  const hash = createHash("sha256");
  async function add(file) {
    const metadata = await stat(file);
    if (metadata.isDirectory()) {
      for (const name of (await readdir(file)).sort()) await add(join(file, name));
      return;
    }
    hash.update(JSON.stringify([relative(base, file).replaceAll("\\", "/"), metadata.size]));
    for await (const chunk of createReadStream(file)) hash.update(chunk);
  }
  for (const name of paths) await add(join(base, name));
  return hash.digest("hex");
}

export async function validateVersion(base) {
  const pkg = JSON.parse(await readFile(join(base, "package.json"), "utf8"));
  const lock = JSON.parse(await readFile(join(base, "package-lock.json"), "utf8"));
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version) || lock.version !== pkg.version || lock.packages?.[""]?.version !== pkg.version) {
    throw new Error("package.json 与 package-lock.json 的版本不一致或无效。");
  }
  return pkg.version;
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
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit", windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`命令失败 (${code ?? signal}): ${args.join(" ")}`)));
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--quick") || args.length > 1) throw new Error("用法: npm run release:desktop [-- --quick]");
  if (process.platform !== "win32" || process.arch !== "x64" || !nodeVersion.isNodeVersionSupported(process.versions.node)) throw new Error("需要 Windows x64 和 Node.js 22.19+。");
  const version = await validateVersion(root);
  const server = join(root, "build/desktop/server");
  const snapshot = join(root, "build/desktop/server-inputs.json");
  const dist = join(root, "build/desktop/dist");
  const initial = await fingerprint(root);
  const npm = process.env.npm_execpath ?? join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
  await run(process.execPath, [npm, "ls", "--omit=dev", "--all", "--parseable"]);
  const tests = (await readdir(join(root, "electron"))).filter((name) => name.endsWith(".test.mjs")).sort().map((name) => join(root, "electron", name));
  await run(process.execPath, ["--test", ...tests]);
  if (args.includes("--quick")) {
    if (!existsSync(snapshot)) throw new Error("没有完整发布构建记录，请先执行 npm run release:desktop。");
    const saved = JSON.parse(await readFile(snapshot, "utf8"));
    if (saved.fingerprint !== initial || saved.version !== version || saved.server !== await fingerprint(server, [".next", "node_modules", "package.json", "next.config.js", "desktop-packages.mjs", "public", "LICENSE"])) throw new Error("生产构建输入或产物已变化，请执行完整发布。");
  } else {
    await rm(snapshot, { force: true });
    await run(process.execPath, [join(root, "electron/build.mjs")]);
    if (await fingerprint(root) !== initial) throw new Error("构建过程中源文件变化，请重新执行。");
    const serverHash = await fingerprint(server, [".next", "node_modules", "package.json", "next.config.js", "desktop-packages.mjs", "public", "LICENSE"]);
    await writeFile(snapshot, JSON.stringify({ version, fingerprint: initial, server: serverHash }) + "\n");
  }
  await mkdir(join(root, "build/desktop"), { recursive: true });
  const output = await mkdtemp(join(root, "build/desktop/release-"));
  try {
    const builder = require.resolve("electron-builder/cli.js");
    const saved = JSON.parse(await readFile(snapshot, "utf8"));
    await run(process.execPath, [builder, "--config", "electron/builder.json", "--win", "--x64", "--config.directories.output", output]);
    if (await fingerprint(root) !== initial || saved.server !== await fingerprint(server, [".next", "node_modules", "package.json", "next.config.js", "desktop-packages.mjs", "public", "LICENSE"])) throw new Error("打包过程中源文件或构建产物变化，请重新执行。");
    const name = `Weclio-${version}-x64-Setup.exe`;
    const file = join(output, name);
    const hash = await validateInstaller(file);
    await mkdir(dist, { recursive: true });
    // 先验证新产物，再替换旧文件；失败时不把旧文件误报为本次构建。
    const staged = join(dist, `${name}.new`);
    await cp(file, staged);
    await rename(staged, join(dist, name));
    // 不保留同名旧 blockmap，避免它与新安装包不匹配。
    await rm(join(dist, `${name}.blockmap`), { force: true });
    await writeFile(join(dist, "SHA256SUMS.txt.new"), `${hash}  ${name}\n`);
    await rename(join(dist, "SHA256SUMS.txt.new"), join(dist, "SHA256SUMS.txt"));
    console.log(`\n安装包: ${join(dist, name)}\nSHA256: ${hash}\n未签名；请在干净 Windows 环境验收后手动发布。`);
  } finally {
    await rm(output, { recursive: true, force: true, maxRetries: 3 });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(`[desktop-release] ${error.message}`); process.exitCode = 1; });
}
