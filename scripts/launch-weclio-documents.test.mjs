import assert from "node:assert/strict";
import { readFile, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const source = await readFile(new URL("../launch-weclio-web.bat", import.meta.url), "utf8");
const code = source.split(/\r?\n:WECLIO_NODE\r?\n/)[1].split(/\r?\n:WECLIO_POWERSHELL\r?\n/)[0];
const subject = { exports: {} };
new Function("require", "module", "exports", code)(createRequire(import.meta.url), subject, subject.exports);
const launcher = subject.exports;

async function sandbox(t) {
  const root = await mkdtemp(join(tmpdir(), "weclio-documents-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function docxFixture(prefix, broken = false) {
  const directory = join(prefix, "node_modules/docx");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "package.json"), JSON.stringify({ name: "docx", version: "9.15.0" }));
  await writeFile(join(directory, "index.js"), broken ? "throw Error('broken docx fixture');" : "exports.Document=class {};exports.Packer={toBuffer:async()=>Buffer.from('fixture')};");
}

test("document environment is child-scoped, works outside the app, and removes duplicate Windows Path keys", () => {
  const env = { Path: "original-path", NODE_PATH: "original-modules", PYTHONHOME: "foreign-python", PYTHONPATH: "foreign-packages", KEEP: "unchanged" };
  const before = structuredClone(env);
  const tools = { python: join("tools", "python.exe"), pandoc: join("pandoc", "pandoc.exe"), soffice: join("office", "soffice.com"), pdftoppm: join("poppler", "pdftoppm.exe"), zip: join("archive", "zip.exe"), unzip: join("git", "unzip.exe") };
  const result = launcher.documentEnvironment(env, tools, "document-modules");
  assert.deepEqual(env, before);
  assert.equal(result.Path, undefined);
  assert.ok(result.PATH.endsWith("original-path"));
  for (const directory of ["tools", "pandoc", "office", "poppler", "archive", "git"]) assert.ok(result.PATH.split(delimiter).includes(directory));
  assert.equal(result.NODE_PATH, ["document-modules", "original-modules"].join(delimiter));
  assert.equal(result.PYTHONHOME, undefined);
  assert.equal(result.PYTHONPATH, undefined);
  assert.equal(result.PYTHONNOUSERSITE, "1");
  assert.equal(result.KEEP, "unchanged");
});

test("docx is installed into a private prefix once, is resolvable from an unrelated workspace, and preserves npm configuration", async (t) => {
  const root = await sandbox(t);
  const calls = [];
  const npm = async (args) => {
    calls.push(args);
    assert.ok(!args.includes("--global"));
    assert.ok(args.includes("docx@9.15.0"));
    const prefix = args[args.indexOf("--prefix") + 1];
    await docxFixture(prefix);
  };
  const modules = await launcher.ensureDocumentNode({ root, node: process.execPath }, npm, () => {});
  assert.ok(modules.startsWith(root));
  assert.equal(await launcher.ensureDocumentNode({ root, node: process.execPath }, npm, () => {}), modules);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes("--ignore-scripts"));
});

test("an unrelated npm prefix is never overwritten to prepare docx", async (t) => {
  const root = await sandbox(t);
  const prefix = join(root, "runtimes", "document-node-9.15.0");
  await mkdir(prefix, { recursive: true });
  await writeFile(join(prefix, "package.json"), '{"name":"user-package","private":true}');
  await assert.rejects(launcher.ensureDocumentNode({ root, node: process.execPath }, async () => assert.fail("must not install"), () => {}), /未知/);
  assert.equal(await readFile(join(prefix, "package.json"), "utf8"), '{"name":"user-package","private":true}');
});

test("npm success is insufficient when docx cannot load", async (t) => {
  const root = await sandbox(t);
  await assert.rejects(launcher.ensureDocumentNode({ root, node: process.execPath }, async (args) => docxFixture(args[args.indexOf("--prefix") + 1], true), () => {}), /docx/);
});

test("a failed document smoke test cannot mark the runtime ready or change the parent environment", async (t) => {
  const root = await sandbox(t);
  const before = { ...process.env };
  const nativeRequire = createRequire(import.meta.url);
  const subject = { exports: {} };
  const fakeSpawn = (command, args, options) => {
    assert.ok(command.endsWith("powershell.exe"));
    assert.equal(options.stdio, "inherit");
    assert.equal(options.timeout, undefined);
    writeFileSync(options.env.WECLIO_DOCUMENT_OUTPUT, JSON.stringify(Object.fromEntries(["python", "pandoc", "soffice", "pdftoppm", "zip", "unzip"].map((name) => [name, process.execPath]))));
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("close", 0));
    return child;
  };
  new Function("require", "module", "exports", code)((name) => name === "node:child_process" ? { ...nativeRequire(name), spawn: fakeSpawn } : nativeRequire(name), subject, subject.exports);
  await assert.rejects(subject.exports.prepareDocumentRuntime({ root, node: process.execPath, source: "fixture.bat" }, async (args) => docxFixture(args[args.indexOf("--prefix") + 1]), () => {}));
  await assert.rejects(readFile(join(root, "document-runtime.json")), { code: "ENOENT" });
  assert.deepEqual({ ...process.env }, before);
});

test("PowerShell probes preserve quoted code and accept version output on stderr", { skip: process.platform !== "win32" }, async (t) => {
  const root = await sandbox(t);
  const script = "$text=[IO.File]::ReadAllText($env:WECLIO_TEST_SOURCE,[Text.Encoding]::UTF8);$part=($text -split '(?m)^:WECLIO_POWERSHELL\\r?$')[1];Invoke-Expression $part.Substring(0,$part.LastIndexOf('try { Start-Weclio;'));if(!(Test-DocumentCommand $env:WECLIO_TEST_NODE @('-e',\"console.log('ready')\") 'ready')){throw 'stdout probe failed'};if(!(Test-DocumentCommand $env:WECLIO_TEST_NODE @('-e',\"console.error('ready')\") 'ready')){throw 'stderr probe failed'};if(Test-DocumentCommand $env:WECLIO_TEST_NODE @('-e','process.exit(1)') 'ready'){throw 'failed process accepted'};Write-Output 'ok'";
  assert.equal(await launcher.powershell(script, { WECLIO_TEST_SOURCE: fileURLToPath(new URL("../launch-weclio-web.bat", import.meta.url)), WECLIO_TEST_NODE: process.execPath, PSModuleAnalysisCachePath: join(root, "module-cache") }), "ok");
});

test("Python reuse does not install packages into the existing interpreter", { skip: process.platform !== "win32" }, async (t) => {
  const root = await sandbox(t);
  const script = "$text=[IO.File]::ReadAllText($env:WECLIO_TEST_SOURCE,[Text.Encoding]::UTF8);$part=($text -split '(?m)^:WECLIO_POWERSHELL\\r?$')[1];Invoke-Expression $part.Substring(0,$part.LastIndexOf('try { Start-Weclio;'));function Get-Command{[CmdletBinding()]param([string]$Name,[switch]$All);[pscustomobject]@{Source='C:\\existing\\python.exe'}};function Test-DocumentCommand{param($File,$Arguments,$Pattern);$File -eq 'C:\\existing\\python.exe'};function Expand-DocumentArchive{throw 'must not download'};Get-DocumentPython $env:WECLIO_TEST_ROOT";
  const output = await launcher.powershell(script, { WECLIO_TEST_SOURCE: fileURLToPath(new URL("../launch-weclio-web.bat", import.meta.url)), WECLIO_TEST_ROOT: root, PSModuleAnalysisCachePath: join(root, "module-cache") });
  assert.equal(output.split(/\r?\n/).at(-1), "C:\\existing\\python.exe");
  assert.match(output, /Python 与 XML 校验库已就绪，跳过安装/);
});

test("document dependencies are prepared only on cold starts and before the Web service starts", () => {
  const main = code.slice(code.indexOf("async function main(options)"));
  assert.ok(main.indexOf("if (await ownedProcess(state))") < main.indexOf("await prepareDocumentRuntime("));
  assert.ok(main.indexOf("await prepareDocumentRuntime(") < main.indexOf("await startServer("));
  assert.doesNotMatch(source, /SetEnvironmentVariable|InstallAllUsers=1|Verb RunAs|pip install --user/);
  assert.match(source, /Get-WeclioDocumentTools/);
  assert.match(source, /--only-binary=:all:/);
  assert.match(source, /Get-CheckedFile/);
});
