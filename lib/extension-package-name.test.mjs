import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { getExtensionPackageName } from "./extension-package-name.ts";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "extension-name-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function manifest(dir, value) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "package.json"), JSON.stringify(value));
}

test("nested extension names do not depend on entry layout", async (t) => {
  const root = await fixture(t);
  for (const entry of ["index.ts", "src/index.ts", "source/deep/main.js"]) {
    const dir = join(root, "extensions", "submarine");
    await mkdir(dirname(join(dir, entry)), { recursive: true });
    await manifest(dir, { name: "@weclio/pi-submarine", pi: { extensions: [`./${entry}`] } });
    assert.equal(getExtensionPackageName(join(dir, entry), root), "@weclio/pi-submarine");
  }
});

test("a standalone single-extension package can use its root name", async (t) => {
  const root = await fixture(t);
  await mkdir(join(root, "source"));
  await manifest(root, { name: "community-extension", pi: { extensions: ["./source/main.ts"] } });
  assert.equal(getExtensionPackageName(join(root, "source/main.ts"), root), "community-extension");
});

test("a collection package name is not reused for its extensions", async (t) => {
  const root = await fixture(t);
  await mkdir(join(root, "extensions"));
  await manifest(root, { name: "collection", pi: { extensions: ["./extensions/a.ts", "./extensions/b.ts"] } });
  assert.equal(getExtensionPackageName(join(root, "extensions/a.ts"), root), undefined);
});

test("missing, unrelated, glob and malformed metadata allow the existing fallback", async (t) => {
  const root = await fixture(t);
  const dir = join(root, "source");
  await mkdir(dir);
  const entry = join(dir, "main.ts");
  assert.equal(getExtensionPackageName(entry, root), undefined);
  for (const value of [
    { name: "unrelated" },
    { name: "unrelated", pi: { extensions: ["./other.ts"] } },
    { name: "collection", pi: { extensions: ["./*.ts"] } },
    { name: " ", pi: { extensions: ["./main.ts"] } },
    null,
  ]) {
    await manifest(dir, value);
    assert.equal(getExtensionPackageName(entry, root), undefined);
  }
  await writeFile(join(dir, "package.json"), "{bad json");
  assert.equal(getExtensionPackageName(entry, root), undefined);
});

test("Windows case differences preserve package names and stop at the owning root", { skip: process.platform !== "win32" }, async (t) => {
  const outer = await fixture(t);
  const root = join(outer, "bundle");
  await mkdir(join(root, "source"), { recursive: true });
  await manifest(outer, { name: "outside", pi: { extensions: ["./bundle/source/main.ts"] } });
  const entry = join(root, "source/main.ts");
  const script = `import { getExtensionPackageName } from ${JSON.stringify(new URL("./extension-package-name.ts", import.meta.url).href)};
    const [entry, root] = process.argv.slice(1);
    console.log(JSON.stringify(getExtensionPackageName(entry, root) ?? null));`;
  const probe = () => {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script, entry, root.toUpperCase()], { encoding: "utf8", timeout: 5000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  assert.equal(probe(), null);
  await manifest(root, { name: "community-extension", pi: { extensions: ["./SOURCE/MAIN.TS"] } });
  assert.equal(probe(), "community-extension");
});

test("name lookup never walks above the owning package root", async (t) => {
  const outer = await fixture(t);
  const root = join(outer, "bundle");
  await mkdir(root);
  await manifest(outer, { name: "outside", pi: { extensions: ["./bundle/index.ts"] } });
  assert.equal(getExtensionPackageName(join(root, "index.ts"), root), undefined);
  assert.equal(getExtensionPackageName(join(outer, "index.ts"), root), undefined);
  assert.equal(getExtensionPackageName(join(root, "index.ts")), undefined);
  assert.equal(getExtensionPackageName(root, root), undefined);
});
