import assert from "node:assert/strict";
import { readFile, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { execFile, execFileSync, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import test from "node:test";

const source = await readFile(new URL("../launch-weclio-web.bat", import.meta.url), "utf8");
const nodeCode = source.split(/\r?\n:WECLIO_NODE\r?\n/)[1]?.split(/\r?\n:WECLIO_POWERSHELL\r?\n/)[0];
assert.ok(nodeCode, "single BAT must contain its own launcher implementation");
const subject = { exports: {} };
new Function("require", "module", "exports", nodeCode)(createRequire(import.meta.url), subject, subject.exports);
const launcher = subject.exports;

async function sandbox(t) {
  const root = await mkdtemp(join(tmpdir(), "weclio-launcher-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function webFixture(app, { broken = false, version = "0.1.10" } = {}) {
  const sdk = join(app, "node_modules/@earendil-works/pi-coding-agent");
  const isexe = join(app, "node_modules/isexe");
  await mkdir(join(app, ".next"), { recursive: true });
  await mkdir(join(app, "bin"));
  await mkdir(join(app, "node_modules/next/dist/bin"), { recursive: true });
  await mkdir(sdk, { recursive: true });
  await mkdir(isexe);
  await writeFile(join(app, "package.json"), JSON.stringify({ name: "@weclio/pi-web", version }));
  await writeFile(join(app, ".next/BUILD_ID"), "fixture");
  await writeFile(join(app, "bin/pi-web.js"), "");
  await writeFile(join(app, "node_modules/next/package.json"), JSON.stringify({ name: "next" }));
  await writeFile(join(app, "node_modules/next/dist/bin/next.js"), "console.log('Next.js v16.3.3');");
  await writeFile(join(sdk, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", exports: { ".": { import: "./index.mjs" } } }));
  await writeFile(join(sdk, "index.mjs"), "import {createRequire} from 'node:module'; createRequire(import.meta.url)('isexe'); export const fixture=true;");
  if (!broken) await writeFile(join(isexe, "index.js"), "module.exports = () => true;");
  return { root: app, version, isexe };
}

function resourceFixture(root, entries = [], initialized = []) {
  const calls = [], warnings = [], versions = new Map();
  const settings = {
    getGlobalSettings: () => ({ packages: entries }),
    setPackages: (packages) => { entries.splice(0, entries.length, ...packages); },
    async flush() {}, drainErrors: () => [],
  };
  const manager = {
    getInstalledPath: (source) => versions.get(source)?.path,
    addSourceToSettings: (source) => { entries.push(source); },
  };
  const receipt = { initialized: [...initialized] };
  return {
    entries, calls, warnings, receipt, versions, settings, manager,
    options: {
      settings, manager, receipt, saveReceipt: async () => {},
      latest: async () => "1.2.0",
      install: async (name, version) => {
        calls.push([name, version]);
        const path = join(root, name);
        await mkdir(path, { recursive: true });
        await writeFile(join(path, "package.json"), JSON.stringify({ name, version }));
        versions.set(`npm:${name}`, { path });
      },
      warn: (message) => warnings.push(message),
    },
  };
}

test("one BAT embeds both bootstrap and launcher; no auxiliary script is required", () => {
  assert.match(source, /set "WECLIO_LAUNCHER_SOURCE=%~f0"/);
  assert.match(source, /const stable = path\.join\(root, 'launch-weclio-web\.bat'\)/);
  assert.match(source, /\$s\.TargetPath=\$env:WECLIO_SHORTCUT_TARGET/);
  assert.doesNotMatch(source, /install-pi-web\.bat/);
  assert.doesNotMatch(source, /-File\s+.*\.ps1/i);
  assert.doesNotMatch(source, /winget\s+(install|upgrade)|npm\s+config\s+set/i);
});

test("mirror failure falls back to official registry, with no unbounded retry", async () => {
  const calls = [];
  const result = await launcher.withRegistry(async (registry) => {
    calls.push(registry);
    if (calls.length === 1) throw new Error("mirror unavailable");
    return "ok";
  }, () => {});
  assert.equal(result, "ok");
  assert.deepEqual(calls, ["https://registry.npmmirror.com/", "https://registry.npmjs.org/"]);
  await assert.rejects(launcher.withRegistry(async () => { throw new Error("offline"); }, () => {}), /offline/);
});

test("registry configuration is child-process scoped, including the public weclio scope", () => {
  const args = launcher.registryArgs("https://registry.npmjs.org/");
  assert.ok(args.includes("--registry=https://registry.npmjs.org/"));
  assert.ok(args.includes("--@weclio:registry=https://registry.npmjs.org/"));
  assert.ok(!args.some((arg) => /^--fetch-(retries|timeout|retry-)/.test(arg)));
});

test("version lookup keeps its short timeout and query-only retry override", async () => {
  const calls = [];
  assert.equal(await launcher.latestVersion("weclio-cli", async (args, timeout) => {
    calls.push({ args, timeout }); return '"0.3.2"';
  }, () => {}), "0.3.2");
  assert.equal(calls[0].timeout, 20000);
  assert.ok(calls[0].args.includes("--fetch-timeout=8000"));
  assert.ok(calls[0].args.includes("--fetch-retries=0"));
});

test("npm install streams progress, ignores query time budgets and finishes before source fallback", async (t) => {
  const root = await sandbox(t);
  const fakeCli = join(root, "fake-npm.cjs");
  const driver = join(root, "driver.cjs");
  await writeFile(fakeCli, `const fs=require('node:fs');
if(process.argv.includes('https://registry.npmmirror.com/')){
  console.log('mirror-progress'); console.error('live-stderr');
  setTimeout(()=>{fs.writeFileSync('mirror-finished','yes');process.exit(7)},150);
}else{
  if(!fs.existsSync('mirror-finished'))throw Error('fallback started too soon');
  console.log('official-progress');setTimeout(()=>console.log('install-done'),150);
}`);
  await writeFile(driver, `const subject={exports:{}};
new Function('require','module','exports',${JSON.stringify(nodeCode)})(require,subject,subject.exports);
subject.exports.withRegistry(registry=>subject.exports.runNpm({node:process.execPath,npmCli:${JSON.stringify(fakeCli)},root:${JSON.stringify(root)}},['install',registry],1),()=>{}).catch(error=>{console.error(error);process.exitCode=1});`);
  const child = spawn(process.execPath, [driver], { cwd: root, windowsHide: true });
  let output = "", errors = "", progressBeforeClose = false;
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { output += chunk; if (output.includes("mirror-progress") && child.exitCode === null) progressBeforeClose = true; });
  child.stderr.on("data", (chunk) => { errors += chunk; });
  await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code) => code === 0 ? resolve() : reject(new Error(errors || output))); });
  assert.ok(progressBeforeClose);
  assert.match(errors, /live-stderr/);
  assert.ok(output.indexOf("mirror-progress") < output.indexOf("official-progress"));
  assert.match(output, /install-done/);
});

test("npm metadata commands still enforce their timeout", async (t) => {
  const root = await sandbox(t);
  const fakeCli = join(root, "slow-npm.cjs");
  await writeFile(fakeCli, "setTimeout(()=>console.log('late'),2000);");
  await assert.rejects(launcher.runNpm({ node: process.execPath, npmCli: fakeCli, root }, ["view"], 50), (error) => error.killed === true);
});

test("unchanged or older mirror versions never cause reinstall or downgrade", () => {
  assert.equal(launcher.versionAfter("0.1.10", "0.1.9"), true);
  assert.equal(launcher.versionAfter("0.1.10", "0.1.10"), false);
  assert.equal(launcher.versionAfter("0.1.9", "0.1.10"), false);
  assert.equal(launcher.versionAfter("bad", "0.1.10"), false);
});

test("first initialization adds ordinary sources without changing existing packages", async (t) => {
  const fixture = resourceFixture(await sandbox(t), ["npm:custom-tools"]);
  await launcher.syncResources(fixture.options);
  assert.equal(fixture.calls.length, 4);
  assert.equal(fixture.entries[0], "npm:custom-tools");
  assert.deepEqual(fixture.entries.slice(1), launcher.DEFAULTS.map(({ name }) => name === "weclio-cli"
    ? { source: `npm:${name}`, skills: ["!skills/sci-search/**"] }
    : `npm:${name}`));
  assert.equal(fixture.receipt.initialized.length, 4);
});

test("CLI default exclusion is initialized once and preserves later user choices across updates", async (t) => {
  const fixture = resourceFixture(await sandbox(t));
  await launcher.syncResources(fixture.options);
  const cli = fixture.entries.find((entry) => entry.source === "npm:weclio-cli");
  assert.deepEqual(cli, { source: "npm:weclio-cli", skills: ["!skills/sci-search/**"] });
  fixture.options.latest = async () => "1.3.0";
  await launcher.syncResources(fixture.options);
  assert.deepEqual(cli.skills, ["!skills/sci-search/**"]);
  delete cli.skills;
  fixture.options.latest = async () => "1.4.0";
  await launcher.syncResources(fixture.options);
  assert.deepEqual(cli, { source: "npm:weclio-cli" });
  cli.skills = ["!skills/tox-eval/**"];
  fixture.options.latest = async () => "1.5.0";
  await launcher.syncResources(fixture.options);
  assert.deepEqual(cli.skills, ["!skills/tox-eval/**"]);
});

test("pre-existing CLI declarations are preserved, including explicit enablement and pins", async (t) => {
  for (const entry of ["npm:weclio-cli", "npm:weclio-cli@0.3.1",
    { source: "npm:weclio-cli", skills: ["+skills/sci-search/SKILL.md"] },
    { source: "npm:weclio-cli", skills: ["!skills/docx/**", "!skills/tra-md2word/**"] },
    { source: "npm:weclio-cli", skills: [] },
    { source: "npm:weclio-cli", autoload: false }]) {
    const fixture = resourceFixture(await sandbox(t), [structuredClone(entry)]);
    await launcher.syncResources(fixture.options);
    assert.deepEqual(fixture.entries[0], entry);
  }
});

for (const priorVersion of [undefined, "1.1.0"]) test(`real SDK enables six global CLI skills except sci-search: ${priorVersion ? "upgrade existing CLI" : "fresh installation"}`, async (t) => {
  const { SettingsManager, DefaultPackageManager } = await import("@earendil-works/pi-coding-agent");
  const root = await sandbox(t);
  const agentDir = join(root, "agent");
  const settings = SettingsManager.create(root, agentDir, { projectTrusted: false });
  const manager = new DefaultPackageManager({ cwd: root, agentDir, settingsManager: settings });
  const receipt = { initialized: [] };
  const warnings = [];
  const skills = ["sci-search", "tox-eval", "tra-md", "read-across", "tra-md2word", "docx"];
  const options = {
    settings, manager, receipt, saveReceipt: async () => {}, latest: async () => "1.2.0",
    install: async (name, version) => {
      const packageRoot = join(agentDir, "npm/node_modules", name);
      await mkdir(packageRoot, { recursive: true });
      await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name, version, pi: { skills: name === "weclio-cli" ? ["./skills"] : [] } }));
      if (name === "weclio-cli") for (const skill of skills) {
        await mkdir(join(packageRoot, "skills", skill), { recursive: true });
        await writeFile(join(packageRoot, "skills", skill, "SKILL.md"), `---\nname: ${skill}\ndescription: fixture\n---\nFixture.\n`);
      }
    },
    warn: (message) => warnings.push(message),
  };
  if (priorVersion) {
    await options.install("weclio-cli", priorVersion);
    for (const skill of ["tra-md2word", "docx"]) await rm(join(agentDir, "npm/node_modules/weclio-cli/skills", skill), { recursive: true });
    settings.setPackages([{ source: "npm:weclio-cli", skills: ["!skills/sci-search/**"] }]);
    await settings.flush();
    receipt.initialized.push("weclio-cli");
  }
  await launcher.syncResources(options);
  assert.deepEqual(warnings, []);
  const saved = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8"));
  assert.deepEqual(saved.packages.find((entry) => entry.source === "npm:weclio-cli"), { source: "npm:weclio-cli", skills: ["!skills/sci-search/**"] });
  const resolved = await manager.resolve();
  for (const skill of skills) {
    const file = join(agentDir, "npm/node_modules/weclio-cli/skills", skill, "SKILL.md");
    assert.ok(await readFile(file, "utf8"));
    assert.equal(resolved.skills.find((entry) => entry.path === file)?.enabled, skill !== "sci-search");
  }
  // 模拟用户重新启用，重读落盘配置后更新不得恢复默认禁用。
  settings.setPackages(saved.packages.map((entry) => typeof entry === "object" && entry.source === "npm:weclio-cli" ? { source: entry.source } : entry));
  await settings.flush();
  const reloaded = SettingsManager.create(root, agentDir, { projectTrusted: false });
  const reloadedManager = new DefaultPackageManager({ cwd: root, agentDir, settingsManager: reloaded });
  await launcher.syncResources({ ...options, settings: reloaded, manager: reloadedManager, latest: async () => "1.3.0" });
  assert.deepEqual(warnings, []);
  const updated = await reloadedManager.resolve();
  assert.equal(updated.skills.find((entry) => entry.path === join(agentDir, "npm/node_modules/weclio-cli/skills/sci-search/SKILL.md"))?.enabled, true);
  // 用户禁用新文档 skills 后，后续更新仍保留选择。
  const excluded = ["!skills/tra-md2word/**", "!skills/docx/**"];
  reloaded.setPackages(reloaded.getGlobalSettings().packages.map((entry) => typeof entry === "object" && entry.source === "npm:weclio-cli" ? { ...entry, skills: excluded } : entry));
  await reloaded.flush();
  await launcher.syncResources({ ...options, settings: reloaded, manager: reloadedManager, latest: async () => "1.4.0" });
  const filtered = await reloadedManager.resolve();
  for (const skill of ["tra-md2word", "docx"]) {
    assert.equal(filtered.skills.find((entry) => entry.path === join(agentDir, "npm/node_modules/weclio-cli/skills", skill, "SKILL.md"))?.enabled, false);
  }
  assert.deepEqual(warnings, []);
});

test("CLI completeness checks include both new document skills without blocking older releases", async (t) => {
  const skills = ["sci-search", "tox-eval", "tra-md", "read-across", "tra-md2word", "docx"];
  for (const bundledSkills of [skills.slice(0, 4), skills]) await t.test(bundledSkills.length === 6 ? "complete release" : "older release", async (t) => {
    const root = await sandbox(t);
    const fixture = resourceFixture(root);
    fixture.settings.applyOverrides = () => {};
    fixture.manager.install = async (source, options) => {
      assert.equal(options?.local, undefined);
      const [, name, version] = /^npm:(.+)@([^@]+)$/.exec(source);
      await fixture.options.install(name, version);
      if (name === "weclio-cli") for (const skill of bundledSkills) {
        const directory = join(root, name, "skills", skill);
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, "SKILL.md"), "fixture");
      }
    };
    const agentDir = join(root, "agent");
    const sdk = {
      getAgentDir: () => agentDir,
      SettingsManager: { create: (cwd, dir, options) => {
        assert.equal(cwd, root);
        assert.equal(dir, agentDir);
        assert.equal(options.projectTrusted, false);
        return fixture.settings;
      } },
      DefaultPackageManager: function (options) {
        assert.equal(options.agentDir, agentDir);
        return fixture.manager;
      },
    };
    const result = await launcher.installResources(sdk, { root, node: process.execPath, npmCli: "fixture-npm" }, fixture.options.latest, fixture.options.warn);
    assert.equal(result, agentDir);
    if (bundledSkills.length === 6) assert.deepEqual(fixture.warnings, []);
    else {
      assert.equal(fixture.warnings.length, 1);
      assert.match(fixture.warnings[0], /tra-md2word、docx/);
      assert.match(fixture.warnings[0], /6/);
    }
  });
});

test("installed resources are not reinstalled when versions match or the mirror is older", async (t) => {
  const fixture = resourceFixture(await sandbox(t), launcher.DEFAULTS.map(({ name }) => `npm:${name}`));
  for (const { name } of launcher.DEFAULTS) await fixture.options.install(name, "1.2.0");
  fixture.calls.length = 0;
  await launcher.syncResources(fixture.options);
  fixture.options.latest = async () => "1.1.0";
  await launcher.syncResources(fixture.options);
  assert.deepEqual(fixture.calls, []);
});

test("deleted defaults are not restored, even if no default remains configured", async (t) => {
  const fixture = resourceFixture(await sandbox(t), [], launcher.DEFAULTS.map(({ name }) => name));
  await launcher.syncResources(fixture.options);
  assert.deepEqual(fixture.calls, []);
  assert.deepEqual(fixture.entries, []);
});

test("disabled resources and user-pinned versions are preserved", async (t) => {
  const entries = launcher.DEFAULTS.map(({ name, kind }, index) => index === 0
    ? `npm:${name}@1.0.0`
    : { source: `npm:${name}`, [kind]: [] });
  const before = structuredClone(entries);
  const fixture = resourceFixture(await sandbox(t), entries);
  await launcher.syncResources(fixture.options);
  assert.deepEqual(fixture.calls, []);
  assert.deepEqual(entries, before);
});

test("lookup failure does not reinstall an already configured resource", async (t) => {
  const fixture = resourceFixture(await sandbox(t), launcher.DEFAULTS.map(({ name }) => `npm:${name}`));
  fixture.options.latest = async () => { throw new Error("offline"); };
  await launcher.syncResources(fixture.options);
  assert.deepEqual(fixture.calls, []);
  assert.equal(fixture.warnings.length, 4);
});

test("a configured package remains removed after an offline first launch", async (t) => {
  const fixture = resourceFixture(await sandbox(t), launcher.DEFAULTS.map(({ name }) => `npm:${name}`));
  fixture.options.latest = async () => { throw new Error("offline"); };
  await launcher.syncResources(fixture.options);
  fixture.entries.length = 0;
  fixture.options.latest = async () => "1.2.0";
  await launcher.syncResources(fixture.options);
  assert.deepEqual(fixture.calls, []);
});

test("an initialized but missing installation is not automatically restored", async (t) => {
  const entries = launcher.DEFAULTS.map(({ name }) => `npm:${name}`);
  const fixture = resourceFixture(await sandbox(t), entries, launcher.DEFAULTS.map(({ name }) => name));
  await launcher.syncResources(fixture.options);
  assert.deepEqual(fixture.calls, []);
});

test("a failed install is not marked initialized and can retry on the next launch", async (t) => {
  const fixture = resourceFixture(await sandbox(t));
  fixture.options.install = async () => { throw new Error("download failed"); };
  await launcher.syncResources(fixture.options);
  assert.deepEqual(fixture.receipt.initialized, []);
  assert.deepEqual(fixture.entries, []);
  assert.equal(fixture.warnings.length, 4);
});

test("settings save failure is reported and does not mark the package initialized", async (t) => {
  const fixture = resourceFixture(await sandbox(t));
  fixture.settings.drainErrors = () => [{ error: new Error("disk full") }];
  await launcher.syncResources(fixture.options);
  assert.deepEqual(fixture.receipt.initialized, []);
  assert.equal(fixture.warnings.length, 4);
});

test("browser search prefers every Chrome location before any Edge location", () => {
  const candidates = launcher.browserCandidates({ LOCALAPPDATA: "C:/user", ProgramFiles: "C:/apps" }, { chrome: "C:/custom/chrome.exe", edge: "C:/custom/msedge.exe" });
  const chrome = candidates.filter((path) => path.endsWith("chrome.exe"));
  const edge = candidates.filter((path) => path.endsWith("msedge.exe"));
  assert.ok(chrome.length > 0 && edge.length > 0);
  assert.deepEqual(candidates, [...chrome, ...edge]);
});

test("shortcut uses the bundled Weclio icon, keeps its stable copy and never invokes the real desktop in this test", async (t) => {
  const root = await sandbox(t);
  const app = join(root, "installed Web 中文");
  const source = join(root, "download.bat");
  const brand = await readFile(new URL("../public/brand/weclio-favicon.ico", import.meta.url));
  await mkdir(join(app, "public/brand"), { recursive: true });
  await writeFile(join(app, "public/brand/weclio-favicon.ico"), brand);
  await writeFile(source, "fixture BAT");
  const calls = [], warnings = [];
  const fakeExec = () => { throw Error("Unexpected native call"); };
  fakeExec[promisify.custom] = async (...args) => { calls.push(args); return { stdout: "", stderr: "" }; };
  const nativeRequire = createRequire(import.meta.url);
  const subject = { exports: {} };
  new Function("require", "module", "exports", nodeCode)((name) => name === "node:child_process" ? { ...nativeRequire(name), execFile: fakeExec } : nativeRequire(name), subject, subject.exports);
  await subject.exports.shortcut(source, root, app, (message) => warnings.push(message));
  assert.deepEqual(await readFile(join(root, "weclio.ico")), brand);
  assert.equal(await readFile(join(root, "launch-weclio-web.bat"), "utf8"), "fixture BAT");
  assert.equal(calls[0][2].env.WECLIO_SHORTCUT_ICON, join(root, "weclio.ico"));
  const script = Buffer.from(calls[0][1].at(-1), "base64").toString("utf16le");
  assert.match(script, /IconLocation=\$env:WECLIO_SHORTCUT_ICON/);
  assert.doesNotMatch(script, /WECLIO_BROWSER/);
  assert.deepEqual(warnings, []);
  await rm(app, { recursive: true });
  await subject.exports.shortcut(join(root, "launch-weclio-web.bat"), root, app, (message) => warnings.push(message));
  assert.equal(warnings.length, 1);
  assert.deepEqual(await readFile(join(root, "weclio.ico")), brand);
});

test("PID existence alone cannot identify our Web service", () => {
  const state = { pid: 123, node: "C:/node.exe", token: "own-token", port: 8888 };
  assert.equal(launcher.isOwnedProcess({ ProcessId: 123, ExecutablePath: "C:/node.exe", CommandLine: "node unrelated.js" }, state), false);
  assert.equal(launcher.isOwnedProcess({ ProcessId: 123, ExecutablePath: "C:/other.exe", CommandLine: "--weclio-instance=own-token" }, state), false);
  assert.equal(launcher.isOwnedProcess({ ProcessId: 123, ExecutablePath: "C:/node.exe", CommandLine: "--weclio-instance=own-token" }, state), true);
});

test("an occupied port owned by another process is never treated as our service", () => {
  assert.equal(launcher.isOwnedListener([{ OwningProcess: 456 }], { pid: 123 }), false);
  assert.equal(launcher.isOwnedListener([{ OwningProcess: 123 }], { pid: 123 }), true);
});

test("a system-reserved default port falls back, while unrelated listen errors remain errors", async () => {
  const ports = [];
  let code = "EACCES";
  const nativeRequire = createRequire(import.meta.url), subject = { exports: {} };
  const fakeNet = { createServer: () => Object.assign(new EventEmitter(), {
    listen(port, hostname, done) { ports.push(port); queueMicrotask(() => port === 8888 ? this.emit("error", Object.assign(Error("listen failed"), { code })) : done()); },
    address: () => ({ port: 12345 }), close: (done) => done(),
  }) };
  new Function("require", "module", "exports", nodeCode)((name) => name === "node:net" ? fakeNet : nativeRequire(name), subject, subject.exports);
  assert.equal(await subject.exports.choosePort(), 12345);
  assert.deepEqual(ports, [8888, 0]);
  code = "EIO";
  await assert.rejects(subject.exports.choosePort(), { code: "EIO" });
});

test("offline Web lookup reuses an existing installation without reinstalling", async (t) => {
  const root = await sandbox(t);
  const globalRoot = join(root, "global 中文 空格/node_modules");
  const app = join(globalRoot, "@weclio/pi-web");
  await webFixture(app);
  const calls = [];
  const result = await launcher.ensureWeb(root, async (args) => { calls.push(args); return globalRoot; }, async () => { throw new Error("offline"); }, () => {});
  assert.equal(result.root, app);
  assert.deepEqual(calls, [["root", "-g"]]);
});

test("a damaged app manifest cannot block a healthy global fallback and is not silently rewritten", async (t) => {
  const root = await sandbox(t);
  const broken = await webFixture(join(root, "broken"));
  const globalRoot = join(root, "global/node_modules");
  const healthy = await webFixture(join(globalRoot, "@weclio/pi-web"));
  await writeFile(join(root, "current-app.json"), JSON.stringify({ root: broken.root }));
  await writeFile(join(broken.root, "package.json"), "{");
  const result = await launcher.ensureWeb(root, async (args) => {
    assert.deepEqual(args, ["root", "-g"]); return globalRoot;
  }, async () => { throw Error("offline"); }, () => {});
  assert.equal(result.root, healthy.root);
  assert.equal(await readFile(join(broken.root, "package.json"), "utf8"), "{");
});

test("a broken Next runtime gets an ordinary npm retry even when the SDK imports successfully", async (t) => {
  const root = await sandbox(t), prefix = join(root, "apps/0.1.10");
  const app = await webFixture(join(prefix, "node_modules/@weclio/pi-web"));
  await writeFile(join(root, "current-app.json"), JSON.stringify({ root: app.root }));
  await writeFile(join(prefix, "package.json"), JSON.stringify({ name: "weclio-launcher-app", private: true }));
  await writeFile(join(prefix, "package-lock.json"), "preserve lock");
  const next = join(app.root, "node_modules/next/dist/bin/next.js");
  await writeFile(next, "require('missing-next-dependency-fixture');");
  let installs = 0;
  const result = await launcher.ensureWeb(root, async (args) => {
    if (args[0] === "root") return join(root, "global/node_modules");
    assert.equal(args[0], "install"); installs++;
    assert.equal(await readFile(join(prefix, "package-lock.json"), "utf8"), "preserve lock");
    await writeFile(next, "console.log('Next.js v16.3.3');");
  }, async () => "0.1.10", () => {});
  assert.equal(installs, 1);
  assert.equal(result.root, app.root);
});

test("an empty Next entry is not accepted as a healthy runtime", async (t) => {
  const app = await webFixture(join(await sandbox(t), "empty-next"));
  await writeFile(join(app.root, "node_modules/next/dist/bin/next.js"), "");
  await assert.rejects(launcher.checkWebRuntime(app), /Next/);
});

test("a broken same-version app gets a normal npm retry without deleting its tree or lockfile", async (t) => {
  const root = await sandbox(t);
  const prefix = join(root, "apps/0.1.10");
  const app = await webFixture(join(prefix, "node_modules/@weclio/pi-web"), { broken: true });
  await writeFile(join(root, "current-app.json"), JSON.stringify({ root: app.root }));
  await writeFile(join(prefix, "package.json"), JSON.stringify({ name: "weclio-launcher-app", private: true }));
  await writeFile(join(prefix, "package-lock.json"), '{"preserve":"lock"}');
  await writeFile(join(prefix, "node_modules/preserve.txt"), "keep");
  const calls = [];
  const result = await launcher.ensureWeb(root, async (args, timeout) => {
    calls.push({ args, timeout });
    if (args[0] === "root") return join(root, "global/node_modules");
    assert.equal(await readFile(join(prefix, "node_modules/preserve.txt"), "utf8"), "keep");
    assert.equal(await readFile(join(prefix, "package-lock.json"), "utf8"), '{"preserve":"lock"}');
    await writeFile(join(app.isexe, "index.js"), "module.exports=()=>true;");
  }, async () => "0.1.10", () => {});
  assert.equal(result.root, app.root);
  const installs = calls.filter(({ args }) => args[0] === "install");
  assert.equal(installs.length, 1);
  assert.equal(installs[0].timeout, undefined);
  assert.ok(installs[0].args.includes("--loglevel=http"));
});

test("npm success with an empty dependency directory is rejected, not silently cleaned or marked usable", async (t) => {
  const root = await sandbox(t);
  const prefix = join(root, "apps/0.1.10");
  const calls = [];
  await assert.rejects(launcher.ensureWeb(root, async (args, timeout) => {
    calls.push({ args, timeout });
    if (args[0] === "root") return join(root, "global/node_modules");
    await webFixture(join(prefix, "node_modules/@weclio/pi-web"), { broken: true });
    await writeFile(join(prefix, "node_modules/preserve.txt"), "keep");
  }, async () => "0.1.10", () => {}), /isexe/);
  assert.equal(calls.filter(({ args }) => args[0] === "install").length, 1);
  assert.equal(await readFile(join(prefix, "node_modules/preserve.txt"), "utf8"), "keep");
  await assert.rejects(readFile(join(root, "current-app.json")), { code: "ENOENT" });
});

test("a failed update falls back only to a runtime-validated older app", async (t) => {
  const root = await sandbox(t);
  const current = await webFixture(join(root, "older"));
  await writeFile(join(root, "current-app.json"), JSON.stringify({ root: current.root }));
  const warnings = [];
  const result = await launcher.ensureWeb(root, async () => {
    await webFixture(join(root, "apps/0.1.11/node_modules/@weclio/pi-web"), { broken: true, version: "0.1.11" });
  }, async () => "0.1.11", (message) => warnings.push(message));
  assert.equal(result.root, current.root);
  assert.ok(warnings.some((message) => message.includes("isexe")));
});

test("a broken existing runtime cannot be reused when version lookup is offline", async (t) => {
  const root = await sandbox(t);
  const current = await webFixture(join(root, "broken"), { broken: true });
  await writeFile(join(root, "current-app.json"), JSON.stringify({ root: current.root }));
  await assert.rejects(launcher.ensureWeb(root, async (args) => { assert.equal(args[0], "root"); return join(root, "global/node_modules"); }, async () => { throw Error("offline"); }, () => {}), /offline/);
});

test("a broken launcher selection does not hide a healthy read-only global fallback", async (t) => {
  const root = await sandbox(t);
  const selected = await webFixture(join(root, "broken"), { broken: true });
  const globalRoot = join(root, "global/node_modules");
  const healthy = await webFixture(join(globalRoot, "@weclio/pi-web"));
  await writeFile(join(root, "current-app.json"), JSON.stringify({ root: selected.root }));
  const result = await launcher.ensureWeb(root, async (args) => {
    assert.deepEqual(args, ["root", "-g"]); return globalRoot;
  }, async () => { throw Error("offline"); }, () => {});
  assert.equal(result.root, healthy.root);
});

test("homepage 200 is not sufficient: read-only SDK API must be healthy without enumerating packages", async (t) => {
  let mode = "error";
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    if (request.url === "/") { response.end("homepage"); return; }
    if (mode === "error") { response.statusCode = 500; response.end("SDK unavailable"); }
    else if (mode === "html") response.end("not skills JSON");
    else response.end(JSON.stringify({ providers: {} }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;
  assert.equal(await launcher.httpReady(port), false);
  mode = "html";
  assert.equal(await launcher.httpReady(port), false);
  mode = "good";
  assert.equal(await launcher.httpReady(port), true);
  assert.ok(requests.includes("/api/models-config"));
  assert.ok(!requests.some((url) => url.startsWith("/api/skills")));
});

test("server launch requests a visible console rather than a detached console-less process", () => {
  const code = launcher.startServer.toString();
  assert.match(code, /Start-Process .*?-WindowStyle Normal -PassThru/);
  assert.doesNotMatch(code, /detached:\s*true|windowsHide:\s*true/);
  assert.match(code, /process\.title='Weclio Web'/);
});

test("launcher explains installation stages without duplicate success messages or task-termination promises", () => {
  assert.equal(source.split("正在打开 Weclio Web…").length - 1, 1);
  assert.ok(source.includes("正在安装 Weclio Web，请稍候…"));
  assert.ok(source.includes("正在更新，请稍候…"));
  for (const stage of ["基础环境", "Web 程序", "文档组件", "默认资源", "启动服务", "打开页面"]) assert.ok(source.includes(`[${stage}]`));
  assert.ok(source.includes("安装插件或技能："));
  assert.ok(source.includes("跳过下载"));
  assert.ok(source.includes("解压安装 LibreOffice"));
  assert.doesNotMatch(source, /复用已运行的 Web|启动本地 Web 服务|已打开 Weclio Web|停止服务及正在运行的任务/);
});

test("Windows native argument quoting round-trips Unicode, quotes, trailing slashes and shell metacharacters", { skip: process.platform !== "win32" }, async (t) => {
  const root = await sandbox(t);
  const file = join(root, "argv 中文.json");
  const values = ["中文 空格", 'quote"inside', "trailing\\", 'before\\"after', "& %! $ ;"];
  const code = "require('node:fs').writeFileSync(process.argv[1],JSON.stringify(process.argv.slice(2)));";
  await launcher.powershell("$ErrorActionPreference='Stop';Start-Process -FilePath $env:WECLIO_TEST_NODE -ArgumentList $env:WECLIO_TEST_ARGS -WindowStyle Hidden -Wait", {
    WECLIO_TEST_NODE: process.execPath,
    WECLIO_TEST_ARGS: launcher.windowsArguments(["-e", code, "--", file, ...values]),
    PSModuleAnalysisCachePath: join(root, "module-cache"),
  });
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), values);
});

test("PowerShell JSON round-trips Unicode paths without depending on the console code page", { skip: process.platform !== "win32" }, async () => {
  const value = await launcher.powershell("@{path='C:\\用户 中文\\node.exe'}|ConvertTo-Json -Compress");
  assert.equal(JSON.parse(value).path, "C:\\用户 中文\\node.exe");
});

test("native visible-console backend preserves identity, logs and special paths, and restarts after exit", { skip: process.platform !== "win32" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "weclio-launcher-native-"));
  const previousCache = process.env.PSModuleAnalysisCachePath;
  process.env.PSModuleAnalysisCachePath = join(root, "module-cache");
  const app = join(root, "项目 中文 空格 & %!");
  await mkdir(join(app, "node_modules/next/dist/bin"), { recursive: true });
  await writeFile(join(app, "package.json"), JSON.stringify({ name: "@weclio/pi-web" }));
  await writeFile(join(app, "node_modules/next/package.json"), JSON.stringify({ name: "next" }));
  const consoleProbe = "$ProgressPreference='SilentlyContinue';Add-Type 'using System.Runtime.InteropServices;public static class WeclioFixtureConsole{[DllImport(\"kernel32.dll\")]public static extern uint GetConsoleProcessList([Out]uint[] ids,uint count);}';$ids=New-Object uint32[] 64;$n=[WeclioFixtureConsole]::GetConsoleProcessList($ids,64);if($n -eq 0){throw 'No console'};@($ids|Where-Object{$_ -ne 0})|ConvertTo-Json -Compress";
  await writeFile(join(app, "node_modules/next/dist/bin/next.js"), `
    console.log('fixture stdout 中文');console.error('fixture stderr 中文');
    const http=require('node:http');const path=require('node:path');const {execFile}=require('node:child_process');
    const port=Number(process.argv[process.argv.indexOf('-p')+1]);
    const server=http.createServer((req,res)=>{
      if(req.url==='/__console_fixture'){
        execFile(path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-EncodedCommand',${JSON.stringify(Buffer.from(consoleProbe, "utf16le").toString("base64"))}],{timeout:15000},(error,stdout)=>{res.statusCode=error?500:200;res.end(error?'console probe failed':stdout);});return;
      }
      res.end(req.url.startsWith('/api/models-config')?JSON.stringify({providers:{}}):'fixture');
      if(req.url==='/__stop_fixture')server.close(()=>process.exit(0));
    });server.listen(port,'127.0.0.1');
  `);
  const stateFile = join(root, "server.json");
  t.after(async () => {
    try {
      let state;
      try { state = JSON.parse(await readFile(stateFile, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
      if (state && await launcher.ownedProcess(state)) {
        try { await fetch(`http://127.0.0.1:${state.port}/__stop_fixture`, { signal: AbortSignal.timeout(3000) }); }
        finally { if (await launcher.ownedProcess(state)) process.kill(state.pid); }
      }
    } finally {
      if (previousCache === undefined) delete process.env.PSModuleAnalysisCachePath; else process.env.PSModuleAnalysisCachePath = previousCache;
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
  const state = await launcher.startServer({ root: app }, { root, node: process.execPath }, stateFile, join(root, "pi-agent"));
  assert.equal(await launcher.ownedProcess(state), true);
  assert.equal(await launcher.ready(state), true);
  assert.equal(await launcher.ownedProcess({ ...state, token: "not-our-process" }), false);
  // 不指定 windowsHide 的后台命令也应继承服务控制台，而不是另开窗口。
  const probe = await fetch(`http://127.0.0.1:${state.port}/__console_fixture`);
  assert.equal(probe.status, 200);
  const members = await probe.json();
  assert.ok((Array.isArray(members) ? members : [members]).includes(state.pid));
  assert.deepEqual(JSON.parse(await readFile(join(root, "current-app.json"), "utf8")), { root: app });
  const log = await readFile(join(root, "server.log"), "utf8");
  assert.match(log, /使用期间请保持此窗口打开。/);
  assert.match(log, /关闭后，可双击桌面图标重新打开。/);
  assert.doesNotMatch(log, /停止服务及正在运行的任务/);
  assert.match(log, /fixture stdout 中文/);
  assert.match(log, /fixture stderr 中文/);
  const stopped = await fetch(`http://127.0.0.1:${state.port}/__stop_fixture`);
  await stopped.text();
  for (let i = 0; i < 10 && await launcher.ownedProcess(state); i++) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(await launcher.ownedProcess(state), false);
  const restarted = await launcher.startServer({ root: app }, { root, node: process.execPath }, stateFile, join(root, "pi-agent"));
  assert.notEqual(restarted.token, state.token);
  assert.equal(await launcher.ownedProcess(restarted), true);
  assert.equal(await launcher.ready(restarted), true);
});

test("the real BAT entry preserves Chinese/spaced paths and runs its embedded Node payload", { skip: process.platform !== "win32" }, async (t) => {
  const root = await sandbox(t);
  const local = join(root, "App Data 中文");
  const directory = join(root, "入口 中文 空格");
  await mkdir(directory);
  const file = join(directory, "安装启动.bat");
  const payload = "require('node:fs').writeFileSync(require('node:path').join(process.argv[5], 'entry.json'), JSON.stringify(process.argv));";
  await writeFile(file, source.replace(nodeCode, payload));
  execFileSync(process.env.ComSpec, ["/d", "/s", "/c", `""${file}""`], {
    env: { ...process.env, LOCALAPPDATA: local, PSModuleAnalysisCachePath: join(root, "module-cache") }, timeout: 30000, windowsHide: true,
    input: "\r\n", windowsVerbatimArguments: true,
  });
  const args = JSON.parse(await readFile(join(local, "WeclioWeb/entry.json"), "utf8"));
  assert.equal(args[1], "--weclio-launcher");
  assert.equal(args[4], file);
  assert.equal(args[5], join(local, "WeclioWeb"));
});

test("runtime download rejects a bad mirror checksum and falls back without executing the download", { skip: process.platform !== "win32" }, async (t) => {
  const root = await sandbox(t);
  const bytes = Buffer.from("verified fixture archive");
  const calls = [];
  const server = createServer((request, response) => { calls.push(request.url); response.end(request.url === "/mirror" ? "bad bytes" : bytes); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const script = "$text=[IO.File]::ReadAllText($env:WECLIO_PARSE_SOURCE,[Text.Encoding]::UTF8);$part=($text -split '(?m)^:WECLIO_POWERSHELL\\r?$')[1];$part=$part.Substring(0,$part.LastIndexOf('try { Start-Weclio;'));Invoke-Expression $part;Get-CheckedFile @($env:WECLIO_MIRROR,$env:WECLIO_OFFICIAL) $env:WECLIO_DOWNLOAD $env:WECLIO_SHA256";
  await promisify(execFile)(join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"), ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
    env: { ...process.env, WECLIO_PARSE_SOURCE: fileURLToPath(new URL("../launch-weclio-web.bat", import.meta.url)), PSModuleAnalysisCachePath: join(root, "module-cache"), WECLIO_MIRROR: origin + "/mirror", WECLIO_OFFICIAL: origin + "/official", WECLIO_DOWNLOAD: join(root, "archive"), WECLIO_SHA256: createHash("sha256").update(bytes).digest("hex") },
    timeout: 15000, windowsHide: true,
  });
  assert.deepEqual(calls, ["/mirror", "/official"]);
  assert.deepEqual(await readFile(join(root, "archive")), bytes);
});

test("PowerShell detects a compatible Node/npm pair without attempting installation", { skip: process.platform !== "win32" }, async (t) => {
  const root = await sandbox(t);
  const script = "$text=[IO.File]::ReadAllText($env:WECLIO_PARSE_SOURCE,[Text.Encoding]::UTF8);$part=($text -split '(?m)^:WECLIO_POWERSHELL\\r?$')[1];$part=$part.Substring(0,$part.LastIndexOf('try { Start-Weclio;'));Invoke-Expression $part;$npm=Join-Path (Split-Path $env:WECLIO_TEST_NODE) 'node_modules/npm/bin/npm-cli.js';if(!(Test-NodePair $env:WECLIO_TEST_NODE $npm)){throw 'Compatible Node/npm pair was rejected'}";
  execFileSync(join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"), ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
    env: { ...process.env, WECLIO_PARSE_SOURCE: fileURLToPath(new URL("../launch-weclio-web.bat", import.meta.url)), WECLIO_TEST_NODE: process.execPath, PSModuleAnalysisCachePath: join(root, "module-cache") },
    timeout: 15000, windowsHide: true,
  });
});

test("an incomplete portable Git is not reused merely because its two exe files exist", { skip: process.platform !== "win32" }, async (t) => {
  const root = await sandbox(t);
  const git = join(root, "runtimes/git-2.56.0.4");
  await mkdir(join(git, "cmd"), { recursive: true });
  await mkdir(join(git, "bin"));
  await writeFile(join(git, "cmd/git.exe"), "");
  await writeFile(join(git, "bin/bash.exe"), "");
  const script = "$text=[IO.File]::ReadAllText($env:WECLIO_PARSE_SOURCE,[Text.Encoding]::UTF8);$part=($text -split '(?m)^:WECLIO_POWERSHELL\\r?$')[1];$part=$part.Substring(0,$part.LastIndexOf('try { Start-Weclio;'));Invoke-Expression $part;function Get-Command{[CmdletBinding()]param([string]$Name,[switch]$All)};function Get-CheckedFile{throw 'fixture archive requested'};$env:ProgramFiles=$env:WECLIO_EMPTY;${env:ProgramFiles(x86)}=$env:WECLIO_EMPTY;$env:LOCALAPPDATA=$env:WECLIO_EMPTY;try{$result=Get-WeclioGit $env:WECLIO_TEST_ROOT;throw 'Invalid Git was accepted'}catch{if($_.Exception.Message -ne 'fixture archive requested'){throw}};exit 0";
  await promisify(execFile)(join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"), ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
    env: { ...process.env, WECLIO_PARSE_SOURCE: fileURLToPath(new URL("../launch-weclio-web.bat", import.meta.url)), WECLIO_TEST_ROOT: root, WECLIO_EMPTY: join(root, "empty"), PSModuleAnalysisCachePath: join(root, "module-cache") },
    timeout: 15000, windowsHide: true,
  });
});

test("PowerShell bootstrap parses on Windows without executing installation", { skip: process.platform !== "win32" }, async (t) => {
  const root = await sandbox(t);
  const script = "$text=[IO.File]::ReadAllText($env:WECLIO_PARSE_SOURCE,[Text.Encoding]::UTF8);$part=($text -split '(?m)^:WECLIO_POWERSHELL\\r?$')[1];$tokens=$null;$errors=$null;[void][Management.Automation.Language.Parser]::ParseInput($part,[ref]$tokens,[ref]$errors);if($errors.Count){$errors|Out-String|Write-Error;exit 1}";
  execFileSync(join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"), ["-NoProfile", "-NonInteractive", "-Command", script], {
    env: { ...process.env, WECLIO_PARSE_SOURCE: fileURLToPath(new URL("../launch-weclio-web.bat", import.meta.url)), PSModuleAnalysisCachePath: join(root, "module-cache") },
    timeout: 15000, windowsHide: true,
  });
});
