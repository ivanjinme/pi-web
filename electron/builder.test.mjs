import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FileMatcher, copyFiles } from "app-builder-lib/out/fileMatcher.js";
import { AppInfo } from "app-builder-lib/out/appInfo.js";
import { fileURLToPath } from "node:url";
import { loadUpdateConfig, makeDownloadOnlyUpdater } from "./updates.mjs";

const config = JSON.parse(await readFile(new URL("./builder.json", import.meta.url), "utf8"));

test("server dependencies have a dedicated resource mapping, including nested dependencies and assets", async (t) => {
  const mapping = config.extraResources.find((entry) => entry.to === "server/node_modules");
  assert.equal(mapping?.from, "build/desktop/server/node_modules");
  const root = await mkdtemp(join(tmpdir(), "weclio-resource-copy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "node_modules");
  const destination = join(root, "resources/server/node_modules");
  const files = ["next/dist/bin/next", "next/node_modules/dependency/index.js", "sdk/resource.wasm", "sdk/LICENSE",
    "@weclio/plugins/extensions/pi-citations/index.ts", "@weclio/plugins/LICENSE",
    "weclio-cli/bin/weclio.js", "weclio-cli/dist/cli.js", "weclio-cli/node_modules/commander/index.js",
    "weclio-cli/skills/docx/scripts/office/validate.py", "weclio-cli/skills/tra-md2word/assets/reference.docx"];
  for (const file of files) {
    await mkdir(join(source, file, ".."), { recursive: true });
    await writeFile(join(source, file), file);
  }
  // builder 对映射根目录下的 node_modules 有特殊过滤，必须从目录本身开始复制。
  await copyFiles([new FileMatcher(source, destination, (value) => value, ["**/*"])]);
  for (const file of files) assert.equal(await readFile(join(destination, file), "utf8"), file);
});

test("installer updater packages only its runtime modules, not obsolete application or build-only modules", () => {
  assert.deepEqual(config.files, [
    "electron/main.mjs", "electron/navigation.mjs", "electron/preload.cjs",
    "electron/updates.mjs", "electron/update-signature.mjs", "electron/update-install.mjs", "electron/update-gate.mjs",
    "electron/production.mjs", "electron/runtime.mjs", "electron/toolsets.mjs", "electron/server.mjs",
    "bin/node-version.js", "LICENSE", "!node_modules/**/*",
  ]);
  assert.deepEqual(config.extraResources.find((entry) => entry.from === "resources"), { from: "resources", to: ".", filter: ["desktop-update.json"] });
});

test("server resources omit build tracing and source maps without losing runtime manifests or assets", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "weclio-server-filter-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "server");
  const destination = join(root, "copied");
  const kept = ["package.json", "next.config.js", "desktop-packages.mjs", "LICENSE", "public/brand/logo.svg", ".next/BUILD_ID", ".next/required-server-files.json", ".next/server/app/api/test/route.js", ".next/static/chunks/test.js", ".next/server/app/page.js.map-data.json"];
  const omitted = [".next/server/app/api/test/route.js.nft.json", ".next/next-server.js.nft.json", ".next/server/chunks/test.js.map", ".next/static/chunks/test.mjs.map", ".next/server/test.cjs.map", ".next/cache/secret.json", ".next/trace", ".next/trace-build"];
  for (const file of [...kept, ...omitted]) {
    await mkdir(join(source, file, ".."), { recursive: true });
    await writeFile(join(source, file), file);
  }
  const mapping = config.extraResources.find((entry) => entry.to === "server");
  await copyFiles([new FileMatcher(source, destination, (value) => value, mapping.filter)]);
  for (const file of kept) assert.equal(await readFile(join(destination, file), "utf8"), file);
  for (const file of omitted) await assert.rejects(readFile(join(destination, file)), { code: "ENOENT" });
});

test("bootstrap installer ships a generated toolset descriptor separately from trust config", () => {
  assert.deepEqual(config.extraResources.find((entry) => entry.to === "desktop-toolset.json"), { from: "build/desktop/toolset.json", to: "desktop-toolset.json" });
});

test("installer has no obsolete shell descriptor or business package resources", () => {
  assert.deepEqual(config.extraResources.map((entry) => entry.to), [".", "server", "server/node_modules", "desktop-toolset.json", "runtime/win-x64"]);
});

test("production updater cache matches the installer cache instead of the development fallback", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const packager = new AppInfo({ metadata: { ...pkg, ...config.extraMetadata }, config });
  const runtime = await loadUpdateConfig({ packaged: true, resourcesPath: fileURLToPath(new URL("../resources/", import.meta.url)) });
  assert.equal(runtime.updaterCacheDirName, packager.updaterCacheDirName);
  const Updater = makeDownloadOnlyUpdater(class {}, runtime.updaterCacheDirName);
  assert.equal((await new Updater().loadUpdateConfig()).updaterCacheDirName, packager.updaterCacheDirName);
});

test("desktop metadata supplies the branded Windows shortcut description", () => {
  assert.equal(config.extraMetadata.description, "Weclio - Build an AI Scientist");
});

test("the application keeps its server outside asar and includes no system Node installer", () => {
  assert.ok(config.files.includes("electron/production.mjs"));
  assert.ok(config.files.includes("!node_modules/**/*"));
  assert.ok(config.extraResources.find((entry) => entry.to === "server").filter.includes("desktop-packages.mjs"));
  assert.deepEqual(config.extraResources.find((entry) => entry.to === "runtime/win-x64").filter, ["tools/**/*"]);
  assert.equal(config.npmRebuild, false);
  assert.equal(config.nsis.deleteAppDataOnUninstall, false);
});

test("every relative import of a packaged main-process module is itself packaged", async () => {
  // asar 只包含 files 里显式列出的文件；漏一个就会在用户机器上变成
  // ERR_MODULE_NOT_FOUND（本地测试直接读磁盘，永远发现不了）。
  const packaged = config.files.filter((name) => !name.startsWith("!"));
  const list = new Set(packaged.map((name) => name.replaceAll("\\", "/")));
  const modules = packaged.filter((name) => /\.(?:mjs|cjs|js)$/.test(name));
  assert.ok(modules.length > 10, "expected a substantial packaged module list");
  for (const name of modules) {
    const source = await readFile(new URL(`../${name}`, import.meta.url), "utf8");
    for (const match of source.matchAll(/(?:from|import)\s*\(?\s*["'](\.[^"']+)["']/g)) {
      const relative = join("electron", match[1]).replaceAll("\\", "/");
      const resolved = relative.startsWith("electron/../")
        ? relative.slice("electron/".length)
        : relative;
      assert.ok(list.has(resolved), `${name} imports ${match[1]}, which is not in builder.json files`);
    }
  }
});
