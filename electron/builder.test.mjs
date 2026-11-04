import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FileMatcher, copyFiles } from "app-builder-lib/out/fileMatcher.js";

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
