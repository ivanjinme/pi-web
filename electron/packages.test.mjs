import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
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
