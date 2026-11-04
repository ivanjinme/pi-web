import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { initializeDesktopPackages } from "./packages.mjs";

const root = resolve(".");
const names = ["@weclio/plugins", "weclio-cli"];
const sources = names.map((name) => `npm:${name}`);

async function fixture(t) {
  const temporary = await mkdtemp(join(tmpdir(), "weclio-packages-"));
  t.after(() => rm(temporary, { recursive: true, force: true, maxRetries: 3 }));
  const agent = join(temporary, "agent");
  await mkdir(agent);
  return { temporary, agent, settings: join(agent, "settings.json") };
}

async function readSettings(agent) {
  return JSON.parse(await readFile(join(agent, "settings.json"), "utf8"));
}

test("fresh desktop seeds the Pi npm directory and registers two unpinned npm sources offline", async (t) => {
  const { agent } = await fixture(t);
  const installed = await initializeDesktopPackages(root, agent);
  assert.deepEqual((await readSettings(agent)).packages, sources);
  const npm = JSON.parse(await readFile(join(agent, "npm", "package.json"), "utf8"));
  assert.equal(npm.private, true);
  for (const name of names) {
    assert.equal(installed[name], join(agent, "npm", "node_modules", name));
    const manifest = JSON.parse(await readFile(join(installed[name], "package.json"), "utf8"));
    assert.equal(manifest.name, name);
    assert.equal(npm.dependencies[name], manifest.version);
  }
  assert.equal(existsSync(join(agent, "npm", "node_modules", "@earendil-works")), false);
  assert.equal(existsSync(join(agent, "desktop-packages")), false);
  assert.equal(existsSync(join(agent, "auth.json")), false);
  const receipt = JSON.parse(await readFile(join(agent, "weclio-desktop-packages.json"), "utf8"));
  assert.deepEqual(receipt.initialized, names);
  assert.equal(receipt.sources, undefined);
});

test("empty and previously interrupted npm directories can complete initialization", async (t) => {
  const { agent } = await fixture(t);
  await mkdir(join(agent, "npm", "node_modules"), { recursive: true });
  await mkdir(join(agent, "npm.123.tmp"));
  await initializeDesktopPackages(root, agent);
  assert.deepEqual((await readSettings(agent)).packages, sources);
  assert.equal(existsSync(join(agent, "npm", "node_modules", "weclio-cli", "bin", "weclio.js")), true);
});

test("existing packages, dependency versions and filtered npm sources are preserved", async (t) => {
  const { agent, settings } = await fixture(t);
  const modules = join(agent, "npm", "node_modules");
  const cli = join(modules, "weclio-cli");
  await mkdir(cli, { recursive: true });
  await writeFile(join(cli, "package.json"), JSON.stringify({ name: "weclio-cli", version: "9.0.0" }));
  await writeFile(join(cli, "user-file"), "user CLI");
  await mkdir(join(modules, "cheerio"));
  await writeFile(join(modules, "cheerio", "package.json"), '{"name":"cheerio","version":"0.0.1"}');
  const manifest = { name: "user-project", private: true, scripts: { keep: "true" }, dependencies: { "weclio-cli": "^9.0.0", "cheerio": "0.0.1" } };
  await writeFile(join(agent, "npm", "package.json"), JSON.stringify(manifest));
  const filtered = { source: "npm:weclio-cli@9.0.0", skills: ["!**"] };
  await writeFile(settings, JSON.stringify({ packages: [filtered], theme: "dark" }));
  await initializeDesktopPackages(root, agent);
  assert.equal(await readFile(join(cli, "user-file"), "utf8"), "user CLI");
  const actual = JSON.parse(await readFile(join(agent, "npm", "package.json"), "utf8"));
  assert.deepEqual(actual, { ...manifest, dependencies: { ...manifest.dependencies, "@weclio/plugins": "0.1.5" } });
  assert.deepEqual((await readSettings(agent)).packages, [filtered, "npm:@weclio/plugins"]);
  assert.equal(await readFile(join(modules, "cheerio", "package.json"), "utf8"), '{"name":"cheerio","version":"0.0.1"}');
});

test("new CLI dependencies are isolated from incompatible user dependencies", async (t) => {
  const { agent } = await fixture(t);
  const dependency = join(agent, "npm", "node_modules", "cheerio");
  await mkdir(dependency, { recursive: true });
  await writeFile(join(dependency, "package.json"), '{"name":"cheerio","version":"0.0.1","main":"index.js"}');
  await writeFile(join(dependency, "index.js"), "throw Error('User dependency must not load');");
  const installed = await initializeDesktopPackages(root, agent);
  const output = execFileSync(process.execPath, [join(installed["weclio-cli"], "bin", "weclio.js"), "--help"], { encoding: "utf8" });
  assert.match(output, /search/);
  const require = createRequire(join(installed["weclio-cli"], "package.json"));
  assert.equal(require("cheerio").load("<p>isolated</p>")("p").text(), "isolated");
  assert.equal(await readFile(join(dependency, "index.js"), "utf8"), "throw Error('User dependency must not load');");
});

test("published packages without a receipt can resume without overwriting user changes", async (t) => {
  const { agent, settings } = await fixture(t);
  const installed = await initializeDesktopPackages(root, agent);
  await rm(join(agent, "weclio-desktop-packages.json"));
  await rm(settings);
  await writeFile(join(installed["weclio-cli"], "user-file"), "keep");
  await initializeDesktopPackages(root, agent);
  assert.deepEqual((await readSettings(agent)).packages, sources);
  assert.equal(await readFile(join(installed["weclio-cli"], "user-file"), "utf8"), "keep");
});

test("failed atomic settings replacement preserves the original and permits a clean retry", async (t) => {
  const { agent, settings } = await fixture(t);
  const original = '{"theme":"dark","custom":{"keep":true}}';
  await writeFile(settings, original);
  const bootstrap = new URL("./packages.mjs", import.meta.url).href;
  const mock = `export * from 'node:fs/promises'; import {rename as original} from 'node:fs/promises'; export async function rename(from,to){if(to===${JSON.stringify(settings)})throw Error('fixture interrupted settings publication');return original(from,to);}`;
  const script = `
    import {registerHooks} from 'node:module';
    registerHooks({resolve(name,context,next){return name==='node:fs/promises'&&context.parentURL===${JSON.stringify(bootstrap)}?{url:${JSON.stringify(`data:text/javascript,${encodeURIComponent(mock)}`)},shortCircuit:true}:next(name,context);}});
    const {initializeDesktopPackages}=await import(${JSON.stringify(bootstrap)});
    await initializeDesktopPackages(${JSON.stringify(root)},${JSON.stringify(agent)});
  `;
  assert.throws(() => execFileSync(process.execPath, ["--input-type=module", "-e", script], { stdio: "pipe", timeout: 30_000 }), (error) => error.stderr.toString().includes("fixture interrupted settings publication"));
  assert.equal(existsSync(join(agent, "npm", "node_modules", "weclio-cli", "package.json")), true);
  assert.equal(await readFile(settings, "utf8"), original);
  assert.equal(existsSync(join(agent, "weclio-desktop-packages.json")), false);
  assert.equal((await readdir(agent)).some((name) => name.endsWith(".tmp")), false);
  await initializeDesktopPackages(root, agent);
  assert.deepEqual(await readSettings(agent), { ...JSON.parse(original), packages: sources });
});

test("interrupted CLI publication leaves no partial package and retries preserve the completed plugin", async (t) => {
  const { agent, settings } = await fixture(t);
  const bootstrap = new URL("./packages.mjs", import.meta.url).href;
  const cli = join(agent, "npm", "node_modules", "weclio-cli");
  const mock = `export * from 'node:fs/promises';import {rename as original} from 'node:fs/promises';export async function rename(from,to){if(to===${JSON.stringify(cli)})throw Error('fixture interrupted package publication');return original(from,to);}`;
  const script = `
    import {registerHooks} from 'node:module';
    registerHooks({resolve(name,context,next){return name==='node:fs/promises'&&context.parentURL===${JSON.stringify(bootstrap)}?{url:${JSON.stringify(`data:text/javascript,${encodeURIComponent(mock)}`)},shortCircuit:true}:next(name,context);}});
    const {initializeDesktopPackages}=await import(${JSON.stringify(bootstrap)});
    await initializeDesktopPackages(${JSON.stringify(root)},${JSON.stringify(agent)});
  `;
  assert.throws(() => execFileSync(process.execPath, ["--input-type=module", "-e", script], { stdio: "pipe", timeout: 30_000 }), (error) => error.stderr.toString().includes("fixture interrupted package publication"));
  const plugin = join(agent, "npm", "node_modules", "@weclio", "plugins");
  assert.equal(existsSync(join(plugin, "package.json")), true);
  assert.equal(existsSync(cli), false);
  assert.equal(existsSync(settings), false);
  assert.equal(existsSync(join(agent, "weclio-desktop-packages.json")), false);
  assert.equal((await readdir(join(agent, "npm", "node_modules"))).some((name) => name.startsWith(".weclio-desktop-")), false);
  await writeFile(join(plugin, "user-file"), "keep completed package");
  await initializeDesktopPackages(root, agent);
  assert.equal(await readFile(join(plugin, "user-file"), "utf8"), "keep completed package");
  assert.deepEqual((await readSettings(agent)).packages, sources);
});

test("configuration edits made during copying are retained when defaults are merged", async (t) => {
  const { agent, settings } = await fixture(t);
  await writeFile(settings, '{"theme":"dark"}');
  const bootstrap = new URL("./packages.mjs", import.meta.url).href;
  const cli = join(agent, "npm", "node_modules", "weclio-cli");
  const manifest = join(agent, "npm", "package.json");
  const mock = `export * from 'node:fs/promises';import {rename as original,writeFile} from 'node:fs/promises';export async function rename(from,to){if(to===${JSON.stringify(cli)}){await writeFile(${JSON.stringify(settings)},JSON.stringify({theme:'light',packages:['npm:user-package']}));await writeFile(${JSON.stringify(manifest)},JSON.stringify({name:'user-project',dependencies:{'user-package':'9.0.0'}}));}return original(from,to);}`;
  const script = `
    import {registerHooks} from 'node:module';
    registerHooks({resolve(name,context,next){return name==='node:fs/promises'&&context.parentURL===${JSON.stringify(bootstrap)}?{url:${JSON.stringify(`data:text/javascript,${encodeURIComponent(mock)}`)},shortCircuit:true}:next(name,context);}});
    const {initializeDesktopPackages}=await import(${JSON.stringify(bootstrap)});
    await initializeDesktopPackages(${JSON.stringify(root)},${JSON.stringify(agent)});
  `;
  execFileSync(process.execPath, ["--input-type=module", "-e", script], { stdio: "pipe", timeout: 30_000 });
  assert.deepEqual(await readSettings(agent), { theme: "light", packages: ["npm:user-package", ...sources] });
  const actual = JSON.parse(await readFile(manifest, "utf8"));
  assert.equal(actual.name, "user-project");
  assert.equal(actual.dependencies["user-package"], "9.0.0");
});

test("settings preflight waits for an active Pi writer before parsing its configuration", async (t) => {
  const { agent, settings } = await fixture(t);
  const { lock } = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"))("proper-lockfile");
  await writeFile(settings, '{"theme":');
  const release = await lock(settings, { realpath: false });
  const current = { theme: "light", packages: ["npm:user-package"], custom: { keep: true } };
  const completion = Promise.allSettled([initializeDesktopPackages(root, agent)]);
  try {
    await delay(100);
    await writeFile(settings, JSON.stringify(current));
  } finally {
    await release();
  }
  const [result] = await completion;
  assert.equal(result.status, "fulfilled", result.reason?.stack);
  assert.deepEqual(await readSettings(agent), { ...current, packages: [...current.packages, ...sources] });
  assert.equal(existsSync(`${settings}.lock`), false);
});

test("stale Pi settings locks are recovered and concurrent initializations serialize", async (t) => {
  const { agent } = await fixture(t);
  const lock = join(agent, "settings.json.lock");
  await mkdir(lock);
  const old = new Date(Date.now() - 60_000);
  await utimes(lock, old, old);
  await Promise.all([initializeDesktopPackages(root, agent), initializeDesktopPackages(root, agent)]);
  assert.deepEqual((await readSettings(agent)).packages, sources);
  assert.equal(existsSync(lock), false);
});

test("repeat startup does not consult bundled resources, rewrite packages or restore removed defaults", async (t) => {
  const { temporary, agent, settings } = await fixture(t);
  const installed = await initializeDesktopPackages(root, agent);
  const first = await readFile(settings, "utf8");
  const cli = join(installed["weclio-cli"], "bin", "weclio.js");
  await writeFile(cli, "// user-owned CLI content\n");
  const noBundledResources = join(temporary, "no-bundled-resources");
  await initializeDesktopPackages(noBundledResources, agent);
  assert.equal(await readFile(settings, "utf8"), first);
  assert.equal(await readFile(cli, "utf8"), "// user-owned CLI content\n");
  await writeFile(settings, '{"packages":[],"theme":"light"}');
  await initializeDesktopPackages(noBundledResources, agent);
  assert.equal(await readFile(settings, "utf8"), '{"packages":[],"theme":"light"}');
});

test("initialization preserves unrelated preferences and credentials", async (t) => {
  const { agent, settings } = await fixture(t);
  await writeFile(settings, JSON.stringify({ theme: "dark", custom: { keep: true } }));
  await writeFile(join(agent, "auth.json"), "private-credential-fixture");
  await initializeDesktopPackages(root, agent);
  assert.deepEqual(await readSettings(agent), { theme: "dark", custom: { keep: true }, packages: sources });
  assert.equal(await readFile(join(agent, "auth.json"), "utf8"), "private-credential-fixture");
});

test("invalid user settings are not reset or marked initialized", async (t) => {
  const { agent, settings } = await fixture(t);
  await writeFile(settings, "{broken");
  await assert.rejects(initializeDesktopPackages(root, agent), /原配置未重置/);
  assert.equal(await readFile(settings, "utf8"), "{broken");
  assert.equal(existsSync(join(agent, "npm")), false);
  assert.equal(existsSync(join(agent, "weclio-desktop-packages.json")), false);
});

test("an incomplete bundled package fails before changing user configuration", async (t) => {
  const { temporary, agent, settings } = await fixture(t);
  for (const name of names) {
    const directory = join(temporary, "node_modules", name);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "package.json"), JSON.stringify({ name, version: "0.1.0", bin: name === "weclio-cli" ? { weclio: "missing.js" } : {} }));
  }
  await assert.rejects(initializeDesktopPackages(temporary, agent), /安装包缺少 weclio-cli/);
  assert.equal(existsSync(settings), false);
  assert.equal(existsSync(join(agent, "npm")), false);
  assert.equal(existsSync(join(agent, "weclio-desktop-packages.json")), false);
});

test("the npm sources expose four extensions, five skills and the CLI without network or package installation", async (t) => {
  const { temporary, agent } = await fixture(t);
  const sdk = pathToFileURL(join(root, "node_modules/@earendil-works/pi-coding-agent/dist/index.js")).href;
  const bootstrap = new URL("./packages.mjs", import.meta.url).href;
  const script = `
    import assert from 'node:assert/strict';
    import { execFileSync } from 'node:child_process';
    import { join } from 'node:path';
    import { DefaultPackageManager, DefaultResourceLoader, SettingsManager } from ${JSON.stringify(sdk)};
    import { initializeDesktopPackages } from ${JSON.stringify(bootstrap)};
    globalThis.fetch = () => { throw Error('Unexpected network request'); };
    const agentDir = process.env.PI_CODING_AGENT_DIR;
    const installed = await initializeDesktopPackages(${JSON.stringify(root)}, agentDir);
    const settingsManager = SettingsManager.create(process.cwd(), agentDir, {projectTrusted:false});
    assert.deepEqual(settingsManager.getGlobalSettings().packages, ${JSON.stringify(sources)});
    const manager = new DefaultPackageManager({cwd:process.cwd(),agentDir,settingsManager});
    for (const name of ${JSON.stringify(names)}) assert.equal(manager.getInstalledPath('npm:'+name,'user'), installed[name]);
    const loader = new DefaultResourceLoader({cwd:process.cwd(),agentDir,settingsManager});
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    assert.equal(loader.getExtensions().extensions.length, 4);
    const skills = loader.getSkills().skills;
    assert.deepEqual(skills.map(s=>s.name).sort(), ['tox-eval','tra-md','read-across','docx','tra-md2word'].sort());
    for (const resource of [...loader.getExtensions().extensions, ...skills.map(s=>({path:s.filePath}))]) assert.ok(resource.path.startsWith(join(agentDir,'npm','node_modules')));
    const output = execFileSync(process.execPath,[join(installed['weclio-cli'],'bin/weclio.js'),'--help'],{encoding:'utf8'});
    assert.match(output,/search/);
  `;
  const env = { ...process.env, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", HOME: temporary, USERPROFILE: temporary, npm_config_offline: "true" };
  // 子进程只保留 Node 与系统命令，不能借用全局 CLI 或 Pi 的已装包。
  for (const key of Object.keys(env)) if (key.toLowerCase() === "path" || ["NODE_PATH", "NODE_OPTIONS"].includes(key)) delete env[key];
  env.PATH = [dirname(process.execPath), process.env.SystemRoot ? join(process.env.SystemRoot, "System32") : "/usr/bin"].join(process.platform === "win32" ? ";" : ":");
  execFileSync(process.execPath, ["--input-type=module", "-e", script], { cwd: temporary, env, stdio: "pipe", timeout: 30_000 });
});
