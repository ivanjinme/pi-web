import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { copyProductionDependency, shouldCopyDependencyFile } from "./package-files.mjs";

test("only known source-map suffixes are excluded", () => {
  for (const name of ["index.js.map", "index.cjs.map", "index.mjs.map", "index.jsx.map", "index.ts.map", "index.cts.map", "index.mts.map", "index.tsx.map", "index.d.ts.map", "index.d.mts.map", "styles.css.map"]) {
    assert.equal(shouldCopyDependencyFile(`/node_modules/@scope/pkg/${name}`), false, name);
    assert.equal(shouldCopyDependencyFile(`C:\\node_modules\\@scope\\pkg\\${name}`), false, name);
  }
  for (const name of ["node_modules", "index.js", "index.d.ts", "LICENSE", "world.map", "source.map", "styles.scss.map", "index.js.map.json", "index.js.map/asset", "index.JS.MAP"]) {
    assert.equal(shouldCopyDependencyFile(name), true, name);
  }
});

test("production copy omits source maps while preserving resource directories and runtime files", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "weclio-package-files-"));
  t.after(() => rm(temporary, { recursive: true, force: true, maxRetries: 3 }));
  const source = join(temporary, "source", "node_modules");
  const destination = join(temporary, "copied", "node_modules");
  const kept = [
    "@scope/pkg/package.json",
    "@scope/pkg/dist/index.js",
    "@scope/pkg/dist/index.cjs",
    "@scope/pkg/dist/index.mjs",
    "@scope/pkg/dist/index.d.ts",
    "@scope/pkg/dist/index.d.mts",
    "@scope/pkg/dist/styles.css",
    "@scope/pkg/LICENSE",
    "@scope/pkg/NOTICE",
    "@scope/pkg/data/world.map",
    "@scope/pkg/data/source.map",
    "@scope/pkg/data/index.js.map.json",
    "@scope/pkg/data/generated.js.map/asset.txt",
    "@scope/pkg/build/engine.wasm",
    "@scope/pkg/build/addon.node",
    "@scope/pkg/node_modules/nested/index.js",
    "@scope/pkg/node_modules/nested/index.d.ts",
    "@scope/pkg/node_modules/nested/LICENSE.md",
    "@scope/pkg/node_modules/@other/deep/index.js",
    "weclio-cli/skills/office/SKILL.md",
    "weclio-cli/skills/office/scripts/convert.py",
    "weclio-cli/skills/office/assets/template.docx",
    "weclio-cli/skills/office/assets/layout.map",
    "weclio-cli/bin/tool",
  ];
  const omitted = [
    "@scope/pkg/dist/index.js.map",
    "@scope/pkg/dist/index.cjs.map",
    "@scope/pkg/dist/index.mjs.map",
    "@scope/pkg/dist/index.ts.map",
    "@scope/pkg/dist/index.d.ts.map",
    "@scope/pkg/dist/index.d.mts.map",
    "@scope/pkg/dist/index.jsx.map",
    "@scope/pkg/dist/index.tsx.map",
    "@scope/pkg/dist/styles.css.map",
    "@scope/pkg/node_modules/nested/index.js.map",
    "@scope/pkg/node_modules/@other/deep/index.js.map",
  ];
  for (const name of [...kept, ...omitted]) {
    const path = join(source, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, Buffer.from(`fixture:${name}\n\0`), { mode: name.endsWith("/bin/tool") ? 0o755 : 0o644 });
  }
  await copyProductionDependency(source, destination);

  async function files(directory, prefix = "") {
    const result = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (entry.isDirectory()) result.push(...await files(join(directory, entry.name), `${name}/`));
      else result.push(name);
    }
    return result;
  }
  assert.deepEqual((await files(destination)).sort(), [...kept].sort());
  for (const name of kept) {
    assert.deepEqual(await readFile(join(destination, name)), await readFile(join(source, name)), name);
  }
  if (process.platform !== "win32") {
    assert.equal((await stat(join(destination, "weclio-cli/bin/tool"))).mode & 0o777, 0o755);
  }
  for (const name of omitted) {
    assert.equal((await stat(join(source, name))).isFile(), true, name);
  }
});
