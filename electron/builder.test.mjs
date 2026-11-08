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

test("updater main modules and sandbox preload are packaged with optional fixed config", () => {
  for (const name of ["preload.cjs", "updates.mjs", "update-signature.mjs", "update-install.mjs", "update-gate.mjs", "toolsets.mjs"]) assert.ok(config.files.includes(`electron/${name}`));
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
  assert.deepEqual(config.extraResources.find((entry) => entry.to === "runtime/win-x64").filter, ["git/**/*", "tools/**/*"]);
  assert.equal(config.npmRebuild, false);
  assert.equal(config.nsis.deleteAppDataOnUninstall, false);
});
