import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fingerprint, validateInstaller, validateVersion } from "./release.mjs";

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "weclio-release-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("release requires matching valid package and lock versions", async (t) => {
  const dir = await fixture(t);
  await writeFile(join(dir, "package.json"), JSON.stringify({ version: "1.2.3" }));
  await writeFile(join(dir, "package-lock.json"), JSON.stringify({ version: "1.2.3", packages: { "": { version: "1.2.3" } } }));
  assert.equal(await validateVersion(dir), "1.2.3");
  await writeFile(join(dir, "package-lock.json"), JSON.stringify({ version: "1.2.4", packages: { "": { version: "1.2.3" } } }));
  await assert.rejects(validateVersion(dir), /版本不一致/);
});

test("quick-build fingerprint changes when a source or dependency file changes", async (t) => {
  const dir = await fixture(t);
  await mkdir(join(dir, "app"));
  await writeFile(join(dir, "app", "page.tsx"), "first");
  await writeFile(join(dir, "package-lock.json"), "lock");
  const paths = ["app", "package-lock.json"];
  const first = await fingerprint(dir, paths);
  assert.equal(await fingerprint(dir, paths), first);
  await writeFile(join(dir, "app", "page.tsx"), "other");
  assert.notEqual(await fingerprint(dir, paths), first);
  await writeFile(join(dir, "app", "page.tsx"), "first");
  await writeFile(join(dir, "package-lock.json"), "changed");
  assert.notEqual(await fingerprint(dir, paths), first);
});

test("installer validation checks PE signature and computes SHA256", async (t) => {
  const dir = await fixture(t);
  const file = join(dir, "setup.exe");
  const bytes = Buffer.alloc(128);
  bytes.write("MZ");
  bytes.writeUInt32LE(80, 60);
  bytes.writeUInt32LE(0x4550, 80);
  bytes.writeUInt16LE(0x8664, 84);
  await writeFile(file, bytes);
  assert.equal(await validateInstaller(file), createHash("sha256").update(await readFile(file)).digest("hex"));
  bytes.writeUInt32LE(0, 80);
  await writeFile(file, bytes);
  await assert.rejects(validateInstaller(file), /PE 签名/);
});
