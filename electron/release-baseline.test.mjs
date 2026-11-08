import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BASELINE_PATH, BASELINE_SCHEMA, decideReleaseKind, readShellBaseline, writeShellBaseline } from "./release-baseline.mjs";

const digest = (fill) => fill.repeat(64);
const SHELL = { schema: 1, version: "1.2.0", digest: digest("a"), toolset: digest("b") };

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "release-baseline-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function list(root) {
  return (await readdir(root, { recursive: true })).map((entry) => entry.replaceAll("\\", "/")).sort();
}

test("baseline path and schema constants", () => {
  assert.equal(BASELINE_PATH, "electron/desktop-shell-baseline.json");
  assert.equal(BASELINE_SCHEMA, 1);
});

test("readShellBaseline returns null when the file is absent", async (t) => {
  const root = await fixture(t);
  assert.equal(await readShellBaseline({ root }), null);
  await mkdir(join(root, "build/desktop"), { recursive: true });
  await writeFile(join(root, "build/desktop/shell.json"), JSON.stringify(SHELL));
  assert.equal(await readShellBaseline({ root }), null);
});

test("readShellBaseline accepts an exact valid descriptor", async (t) => {
  const root = await fixture(t);
  await mkdir(join(root, "electron"), { recursive: true });
  // 键顺序与文件布局无关，只校验字段集合与取值。
  await writeFile(join(root, BASELINE_PATH), JSON.stringify({ toolset: digest("b"), digest: digest("a"), version: "1.2.0", schema: 1 }));
  assert.deepEqual(await readShellBaseline({ root }), SHELL);
  assert.deepEqual(await readShellBaseline({ root, path: join(root, BASELINE_PATH) }), SHELL);
});

test("readShellBaseline rejects malformed baselines with an actionable error", async (t) => {
  const root = await fixture(t);
  const file = join(root, BASELINE_PATH);
  await mkdir(join(root, "electron"), { recursive: true });
  const cases = [
    ["not json", "{", /not valid JSON/],
    ["array", JSON.stringify([SHELL]), /expected exactly the fields/],
    ["null", "null", /expected exactly the fields/],
    ["extra field", JSON.stringify({ ...SHELL, extra: 1 }), /expected exactly the fields/],
    ["missing field", JSON.stringify({ schema: 1, version: "1.2.0", digest: digest("a") }), /expected exactly the fields/],
    ["schema", JSON.stringify({ ...SHELL, schema: 2 }), /schema must be 1/],
    ["version", JSON.stringify({ ...SHELL, version: "1.2" }), /stable major\.minor\.patch/],
    ["version prerelease", JSON.stringify({ ...SHELL, version: "1.2.0-rc" }), /stable major\.minor\.patch/],
    ["digest upper case", JSON.stringify({ ...SHELL, digest: digest("A") }), /digest must be a lowercase SHA-256/],
    ["digest short", JSON.stringify({ ...SHELL, digest: digest("a").slice(1) }), /digest must be a lowercase SHA-256/],
    ["digest type", JSON.stringify({ ...SHELL, digest: 1 }), /digest must be a lowercase SHA-256/],
    ["toolset", JSON.stringify({ ...SHELL, toolset: digest("c").slice(1) }), /toolset must be a lowercase SHA-256/],
  ];
  for (const [label, text, pattern] of cases) {
    await writeFile(file, text);
    await assert.rejects(readShellBaseline({ root }), (error) => {
      assert.match(error.message, /Invalid desktop shell baseline .*desktop-shell-baseline\.json/, label);
      assert.match(error.message, pattern, label);
      return true;
    });
  }
});

test("decideReleaseKind treats the first release as a shell", () => {
  for (const baseline of [null, undefined]) {
    const decision = decideReleaseKind({ currentShell: SHELL, baseline });
    assert.equal(decision.kind, "shell");
    assert.equal(decision.sameDigest, false);
    assert.match(decision.reason, /first shell release/);
  }
});

test("decideReleaseKind requires a shell when content or toolset changed", () => {
  const changed = decideReleaseKind({ currentShell: { ...SHELL, version: "2.0.0", digest: digest("c") }, baseline: SHELL });
  assert.equal(changed.kind, "shell");
  assert.equal(changed.sameDigest, false);
  assert.match(changed.reason, /shell content changed/);

  const toolset = decideReleaseKind({ currentShell: { ...SHELL, version: "2.0.0", toolset: digest("d") }, baseline: SHELL });
  assert.equal(toolset.kind, "shell");
  assert.equal(toolset.sameDigest, true);
  assert.match(toolset.reason, /toolset/);
});

test("decideReleaseKind accepts an application release only for a newer version", () => {
  const decision = decideReleaseKind({ currentShell: { ...SHELL, version: "1.3.0" }, baseline: SHELL });
  assert.deepEqual(decision, {
    kind: "application",
    sameDigest: true,
    reason: `shell ${SHELL.digest} is unchanged since 1.2.0; 1.3.0 changes application files only`,
  });
});

test("decideReleaseKind refuses an unchanged or older release", () => {
  for (const version of ["1.2.0", "1.1.9"]) {
    assert.throws(() => decideReleaseKind({ currentShell: { ...SHELL, version }, baseline: SHELL }), (error) => {
      assert.match(error.message, /No release change/);
      assert.match(error.message, /1\.2\.0/);
      return true;
    });
  }
});

test("decideReleaseKind validates both descriptors", () => {
  assert.throws(() => decideReleaseKind({ currentShell: { ...SHELL, digest: "x" }, baseline: null }), /Invalid current desktop shell descriptor/);
  assert.throws(() => decideReleaseKind({ currentShell: SHELL, baseline: { ...SHELL, schema: 0 } }), /Invalid desktop shell baseline/);
});

test("writeShellBaseline creates the parent directory and writes the exact schema", async (t) => {
  const root = await fixture(t);
  assert.deepEqual(await writeShellBaseline({ root, shell: SHELL }), SHELL);
  const file = join(root, BASELINE_PATH);
  assert.equal(await readFile(file, "utf8"), `{"schema":1,"version":"1.2.0","digest":"${digest("a")}","toolset":"${digest("b")}"}\n`);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), SHELL);
  assert.deepEqual(await readShellBaseline({ root }), SHELL);
  assert.deepEqual(await list(join(root, "electron")), ["desktop-shell-baseline.json"]);
});

test("writeShellBaseline accepts any forward version, even with a changed digest", async (t) => {
  const root = await fixture(t);
  await writeShellBaseline({ root, shell: SHELL });
  const next = { schema: 1, version: "1.3.0", digest: digest("c"), toolset: digest("b") };
  assert.deepEqual(await writeShellBaseline({ root, shell: next }), next);
  assert.deepEqual(await readShellBaseline({ root }), next);
  const jump = { schema: 1, version: "2.0.0", digest: digest("d"), toolset: digest("e") };
  assert.deepEqual(await writeShellBaseline({ root, shell: jump }), jump);
  assert.deepEqual(await readShellBaseline({ root }), jump);
});

test("writeShellBaseline is idempotent for an identical published descriptor", async (t) => {
  const root = await fixture(t);
  await writeShellBaseline({ root, shell: SHELL });
  assert.deepEqual(await writeShellBaseline({ root, shell: { ...SHELL } }), SHELL);
  assert.deepEqual(await readShellBaseline({ root }), SHELL);
});

test("writeShellBaseline refuses to move the version backwards", async (t) => {
  const root = await fixture(t);
  await writeShellBaseline({ root, shell: SHELL });
  for (const version of ["1.1.0", "1.1.9", "0.9.9"]) {
    await assert.rejects(writeShellBaseline({ root, shell: { ...SHELL, version, digest: digest("c") } }), /Refusing to move the desktop shell baseline backwards/);
  }
  assert.deepEqual(await readShellBaseline({ root }), SHELL);
});

test("writeShellBaseline refuses to rewrite a published version with different content", async (t) => {
  const root = await fixture(t);
  await writeShellBaseline({ root, shell: SHELL });
  await assert.rejects(writeShellBaseline({ root, shell: { ...SHELL, digest: digest("c") } }), /Refusing to rewrite the published desktop shell baseline/);
  await assert.rejects(writeShellBaseline({ root, shell: { ...SHELL, toolset: digest("d") } }), /Refusing to rewrite the published desktop shell baseline/);
  assert.deepEqual(await readShellBaseline({ root }), SHELL);
});

test("writeShellBaseline performs no IO when validation fails", async (t) => {
  const root = await fixture(t);
  const file = join(root, BASELINE_PATH);
  await mkdir(join(root, "electron"), { recursive: true });
  await writeFile(file, JSON.stringify(SHELL));
  const before = await list(root);
  for (const shell of [{ ...SHELL, schema: 2 }, { ...SHELL, digest: digest("a").slice(1) }, { ...SHELL, version: "1.2" }, { ...SHELL, extra: 1 }, null, "nope"]) {
    await assert.rejects(writeShellBaseline({ root, shell }), /Invalid current desktop shell descriptor/);
  }
  assert.deepEqual(await list(root), before);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), SHELL);
  const malformed = await fixture(t);
  await mkdir(join(malformed, "electron"), { recursive: true });
  await writeFile(join(malformed, BASELINE_PATH), "{");
  await assert.rejects(writeShellBaseline({ root: malformed, shell: { ...SHELL, version: "2.0.0" } }), /Invalid desktop shell baseline/);
  assert.deepEqual(await list(malformed), ["electron", "electron/desktop-shell-baseline.json"]);
});

test("writeShellBaseline keeps the published file intact when the atomic rename fails", async (t) => {
  const root = await fixture(t);
  await writeShellBaseline({ root, shell: SHELL });
  const before = await readFile(join(root, BASELINE_PATH), "utf8");
  // 目录占位让 rename 在 Windows 上失败；失败后不得留下临时文件或半成品。
  const blocking = await fixture(t);
  await mkdir(join(blocking, BASELINE_PATH), { recursive: true });
  await assert.rejects(writeShellBaseline({ root: blocking, shell: SHELL }));
  assert.deepEqual(await list(join(blocking, "electron")), ["desktop-shell-baseline.json"]);
  assert.equal(await readFile(join(root, BASELINE_PATH), "utf8"), before);
  assert.deepEqual(await readdir(join(root, "electron")), ["desktop-shell-baseline.json"]);
});