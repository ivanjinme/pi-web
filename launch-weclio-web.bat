@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
title Weclio Web
set "WECLIO_LAUNCHER_SOURCE=%~f0"
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command "$text=[IO.File]::ReadAllText($env:WECLIO_LAUNCHER_SOURCE,[Text.Encoding]::UTF8); & ([scriptblock]::Create(($text -split '(?m)^:WECLIO_POWERSHELL\r?$')[1]))"
set "WECLIO_EXIT=%ERRORLEVEL%"
if not "%WECLIO_EXIT%"=="0" pause
exit /b %WECLIO_EXIT%

:WECLIO_NODE
// 单文件启动器：此段由下方 PowerShell 从当前 BAT 中读取，不依赖外部脚本。
/* eslint-disable @typescript-eslint/no-require-imports -- 单文件 BAT 的 CommonJS 运行入口。 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const { randomUUID, createHash } = require('node:crypto');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { findPackageJSON, createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
/* eslint-enable @typescript-eslint/no-require-imports */
const exec = promisify(execFile);
const REGISTRIES = ['https://registry.npmmirror.com/', 'https://registry.npmjs.org/'];
const DEFAULTS = [
  { name: '@weclio/pi-web-search', kind: 'extensions' },
  { name: '@weclio/pi-submarine', kind: 'extensions' },
  { name: '@weclio/pi-citations', kind: 'extensions' },
  { name: 'weclio-cli', kind: 'skills' },
];
const REQUIRED_SKILLS = ['sci-search', 'tox-eval', 'tra-md', 'read-across', 'tra-md2word', 'docx'];
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function withActivity(message, action, intervalMs = 500) {
  let frame = 0;
  const draw = () => process.stdout.write('\r  ' + message + '.'.repeat(frame++ % 3 + 1).padEnd(3));
  draw();
  const timer = setInterval(draw, intervalMs);
  try { return await action(); }
  finally { clearInterval(timer); process.stdout.write('\r  ' + message + '...\n'); }
}
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
function writeJson(file, value) {
  const temporary = file + '.' + randomUUID() + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2));
  fs.renameSync(temporary, file);
}
function versionAfter(candidate, installed) {
  if (!/^\d+\.\d+\.\d+$/.test(candidate || '')) return false;
  const current = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(installed || '');
  if (!current) return false;
  const next = candidate.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (next[i] !== Number(current[i + 1])) return next[i] > Number(current[i + 1]);
  }
  return installed.includes('-');
}
function registryArgs(registry) {
  return ['--registry=' + registry, '--@weclio:registry=' + registry, '--audit=false', '--fund=false'];
}
async function runNpm(options, args, timeout) {
  if (args[0] !== 'install') {
    const message = args[0] === 'view' ? '检查版本：' + args[1] : '检查 npm 安装位置';
    const { stdout } = await withActivity(message, () => exec(options.node, [options.npmCli, ...args], { cwd: options.root, timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }));
    return stdout;
  }
  // 安装交给 npm 自己处理请求超时和重试；直通输出，不用总时限或缓冲区上限强杀。
  await new Promise((resolve, reject) => {
    const child = spawn(options.node, [options.npmCli, ...args], { cwd: options.root, windowsHide: true, stdio: 'inherit' });
    child.once('error', reject);
    child.once('close', (code, signal) => code === 0 ? resolve() : reject(new Error('npm 安装退出：' + (signal || code))));
  });
  return '';
}
async function withRegistry(action, warn) {
  let last;
  for (const registry of REGISTRIES) {
    try { return await action(registry); }
    catch (error) { last = error; warn('源不可用或操作失败：' + registry + '；尝试下一来源。'); }
  }
  throw last;
}
async function latestVersion(name, npm, warn) {
  return withRegistry(async (registry) => {
    const output = await npm(['view', name + '@latest', 'version', '--json', ...registryArgs(registry), '--fetch-timeout=8000', '--fetch-retries=0'], 20000);
    const version = JSON.parse(output);
    if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error('无有效稳定版本：' + name);
    return version;
  }, warn);
}
function resourceDecision(resource, entries, initialized) {
  const prefix = 'npm:' + resource.name;
  const entry = entries.find((value) => {
    const source = typeof value === 'string' ? value : value.source;
    return source === prefix || source.startsWith(prefix + '@');
  });
  if (!entry) return initialized.includes(resource.name) ? { action: 'skip' } : { action: 'install' };
  const source = typeof entry === 'string' ? entry : entry.source;
  if (source !== prefix && source !== prefix + '@latest') return { action: 'skip', entry };
  if (typeof entry === 'object' && (entry.autoload === false || (Array.isArray(entry[resource.kind]) && entry[resource.kind].length === 0))) return { action: 'skip', entry };
  return { action: 'update', source, entry };
}
async function syncResources({ settings, manager, receipt, saveReceipt, latest, install, warn }) {
  for (const resource of DEFAULTS) {
    const wasInitialized = receipt.initialized.includes(resource.name);
    const entries = settings.getGlobalSettings().packages || [];
    const decision = resourceDecision(resource, entries, receipt.initialized);
    // 首次见到已有配置就记录，不能因查更新断网而在用户删除后再次补回。
    if (decision.entry && !wasInitialized) { receipt.initialized.push(resource.name); await saveReceipt(); }
    if (decision.action === 'skip') continue;
    try {
      const installedPath = decision.source && manager.getInstalledPath(decision.source, 'user');
      const installed = installedPath && readJson(path.join(installedPath, 'package.json'), null);
      // 已初始化后，手动删除的安装目录也不由启动器补回；Pi 的正常资源管理不受影响。
      if (decision.action === 'update' && !installed && wasInitialized) continue;
      const target = await latest(resource.name);
      if (!installed || versionAfter(target, installed.version)) {
        await install(resource.name, target);
        if (decision.action === 'install') {
          const source = 'npm:' + resource.name;
          // 仅首次新增 CLI 来源时禁用；已有配置及用户后续选择不覆盖。
          if (resource.name === 'weclio-cli') settings.setPackages([
            ...(settings.getGlobalSettings().packages || []),
            { source, skills: ['!skills/sci-search/**'] },
          ]);
          else manager.addSourceToSettings(source);
        }
        await settings.flush();
        const errors = settings.drainErrors();
        if (errors.length) throw errors[0].error;
        const saved = settings.getGlobalSettings().packages || [];
        if (!saved.some((entry) => (typeof entry === 'string' ? entry : entry.source) === (decision.source || 'npm:' + resource.name))) throw new Error('包配置未保存');
      }
      if (!receipt.initialized.includes(resource.name)) { receipt.initialized.push(resource.name); await saveReceipt(); }
    } catch (error) { warn(resource.name + ' 尚未完成安装或更新：' + error.message); }
  }
}
function browserCandidates(env, registered = {}) {
  const directories = [env.LOCALAPPDATA, env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean);
  return [registered.chrome, ...directories.map((base) => path.join(base, 'Google/Chrome/Application/chrome.exe')),
    registered.edge, ...directories.map((base) => path.join(base, 'Microsoft/Edge/Application/msedge.exe'))].filter(Boolean);
}
function isOwnedProcess(info, state) {
  return !!info && info.ProcessId === state.pid && typeof info.ExecutablePath === 'string'
    && info.ExecutablePath.toLowerCase() === state.node.toLowerCase()
    && typeof info.CommandLine === 'string' && info.CommandLine.includes('--weclio-instance=' + state.token);
}
function isOwnedListener(connections, state) {
  return (Array.isArray(connections) ? connections : connections ? [connections] : []).some((connection) => connection.OwningProcess === state.pid);
}
async function powershell(script, env = {}) {
  const executable = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const utf8Script = "[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false);$ProgressPreference='SilentlyContinue';" + script;
  const { stdout } = await exec(executable, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(utf8Script, 'utf16le').toString('base64')], {
    env: { ...process.env, ...env }, windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
}
async function ownedProcess(state) {
  if (!state || !Number.isSafeInteger(state.pid) || state.pid <= 0 || !Number.isSafeInteger(state.port) || state.port < 1 || state.port > 65535 || typeof state.node !== 'string' || !/^[\w-]+$/.test(state.token || '')) return false;
  const output = await powershell(`Get-CimInstance Win32_Process -Filter 'ProcessId=${state.pid}' | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress`);
  return output ? isOwnedProcess(JSON.parse(output), state) : false;
}
async function ready(state) {
  const listeners = await powershell(`@(Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort ${state.port} -State Listen -ErrorAction SilentlyContinue | Select-Object OwningProcess) | ConvertTo-Json -Compress`);
  if (!listeners || !isOwnedListener(JSON.parse(listeners), state)) return false;
  return httpReady(state.port);
}
async function httpReady(port) {
  // skills 枚举会经 SDK 自动补装缺失来源；常规健康检查只读配置，不触发资源管理。
  for (const endpoint of ['/', '/api/models-config']) {
    const valid = await new Promise((resolve) => {
      const request = http.get({ hostname: '127.0.0.1', port, path: endpoint, agent: false, timeout: 3000 }, (response) => {
        response.on('error', () => resolve(false));
        if (response.statusCode !== 200) { response.resume(); resolve(false); return; }
        if (endpoint === '/') { response.resume(); resolve(true); return; }
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => { body += chunk; });
        response.on('end', () => {
          try { JSON.parse(body); resolve(true); }
          catch { resolve(false); }
        });
      });
      request.on('error', () => resolve(false));
      request.on('timeout', () => { resolve(false); request.destroy(); });
    });
    if (!valid) return false;
  }
  return true;
}
async function waitReady(state) {
  return withActivity('等待本地服务响应', async () => {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      if (!await ownedProcess(state)) throw new Error('Web 服务已退出，请查看 server.log。');
      if (await ready(state)) return;
      await pause(1000);
    }
    throw new Error('Web 服务未在 60 秒内就绪；不强制结束进程，请查看 server.log。');
  });
}
async function choosePort() {
  const listen = (port) => new Promise((resolve, reject) => {
    const server = net.createServer(); server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { const chosen = server.address().port; server.close(() => resolve(chosen)); });
  });
  try { return await listen(8888); } catch (error) { if (!['EADDRINUSE', 'EACCES'].includes(error.code)) throw error; return listen(0); }
}
async function findBrowser() {
  const output = await powershell("$result=@{};foreach($name in @('chrome','msedge')){foreach($hive in @('HKCU:','HKLM:')){$key=Get-Item ($hive+'\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\'+$name+'.exe') -ErrorAction SilentlyContinue;if($key){$result[$name]=$key.GetValue('');break}}};@{chrome=$result['chrome'];edge=$result['msedge']}|ConvertTo-Json -Compress");
  const browser = browserCandidates(process.env, JSON.parse(output)).find((file) => fs.existsSync(file));
  if (!browser) throw new Error('未找到 Chrome 或 Microsoft Edge，请安装其中一个后再次点击本脚本。');
  return browser;
}
async function openBrowser(browser, state) {
  console.log('[打开页面] 正在打开浏览器…');
  await new Promise((resolve, reject) => {
    const child = spawn(browser, ['http://127.0.0.1:' + state.port], { detached: true, stdio: 'ignore' });
    child.once('error', reject); child.once('spawn', () => { child.unref(); resolve(); });
  });
}
async function shortcut(source, root, appRoot, warn) {
  const stable = path.join(root, 'launch-weclio-web.bat');
  if (path.resolve(source).toLowerCase() !== path.resolve(stable).toLowerCase()) fs.copyFileSync(source, stable);
  const icon = path.join(root, 'weclio.ico');
  try { fs.copyFileSync(path.join(appRoot, 'public/brand/weclio-favicon.ico'), icon); }
  catch (error) { warn('Weclio 图标更新未完成：' + error.message); }
  const result = await powershell("$w=New-Object -ComObject WScript.Shell;$file=Join-Path ([Environment]::GetFolderPath('Desktop')) 'Weclio Web.lnk';$s=$w.CreateShortcut($file);if((Test-Path -LiteralPath $file) -and $s.TargetPath -ne $env:WECLIO_SHORTCUT_TARGET){Write-Output 'exists';exit 0};$s.TargetPath=$env:WECLIO_SHORTCUT_TARGET;$s.WorkingDirectory=Split-Path $env:WECLIO_SHORTCUT_TARGET;$s.IconLocation=$env:WECLIO_SHORTCUT_ICON+',0';$s.Description='安装、更新并打开 Weclio Web';$s.Save()", { WECLIO_SHORTCUT_TARGET: stable, WECLIO_SHORTCUT_ICON: icon });
  if (result === 'exists') warn('已有其他同名快捷方式，未覆盖；仍可点击本脚本启动。');
}
function webAt(root) {
  if (!root) return null;
  const manifest = readJson(path.join(root, 'package.json'), null);
  if (manifest?.name !== '@weclio/pi-web' || !fs.existsSync(path.join(root, '.next/BUILD_ID')) || !fs.existsSync(path.join(root, 'bin/pi-web.js'))) return null;
  return { root, version: manifest.version };
}
function sdkUrl(app) {
  const manifestFile = findPackageJSON('@earendil-works/pi-coding-agent', pathToFileURL(path.join(app.root, 'package.json')));
  const manifest = readJson(manifestFile);
  return pathToFileURL(path.resolve(path.dirname(manifestFile), manifest.exports['.'].import)).href;
}
async function checkWebRuntime(app) {
  try {
    const next = createRequire(path.join(app.root, 'package.json')).resolve('next/dist/bin/next');
    // 独立验证 SDK 及 Next CLI，避免坏依赖被复用或污染随后 npm 重试的模块缓存。
    const { stdout } = await withActivity('检查 Web 运行依赖', () => exec(process.execPath, ['--input-type=module', '-e', "import{createRequire}from'node:module';await import(process.argv[1]);const next=process.argv[2];process.argv=[process.execPath,next,'--version'];createRequire(next)(next);", sdkUrl(app), next], { cwd: app.root, timeout: 60000, windowsHide: true, maxBuffer: 1024 * 1024 }));
    if (!/\bNext\.js v\d+\.\d+\.\d+/.test(stdout)) throw new Error('Next 启动入口未能正常运行');
  } catch (error) { throw new Error('Web 核心运行依赖不可用：' + error.message); }
  return app;
}
async function ensureWeb(root, npm, latest, warn) {
  const usable = async (directory) => {
    try { const candidate = webAt(directory); return candidate ? await checkWebRuntime(candidate) : null; }
    catch (error) { warn(error.message + '；尝试其他可用版本或由 npm 正常安装，不自动清理目录。'); return null; }
  };
  const selected = readJson(path.join(root, 'current-app.json'), null);
  let current = await usable(selected?.root);
  if (!current) {
    const globalRoot = (await npm(['root', '-g'], 20000)).trim();
    current = await usable(path.join(globalRoot, '@weclio/pi-web'));
  }
  let target;
  try { target = await latest('@weclio/pi-web'); }
  catch (error) { if (current) { warn('无法检查 Web 更新，使用已安装版本。'); return current; } throw error; }
  if (current && !versionAfter(target, current.version)) return current;
  const prefix = path.join(root, 'apps', target);
  fs.mkdirSync(prefix, { recursive: true });
  const manifestFile = path.join(prefix, 'package.json');
  if (!fs.existsSync(manifestFile)) writeJson(manifestFile, { name: 'weclio-launcher-app', private: true });
  const existing = readJson(manifestFile);
  if (existing.name !== 'weclio-launcher-app' || existing.private !== true) throw new Error('不覆盖未知应用目录：' + prefix);
  try {
    console.log(current ? '正在更新，请稍候…' : '正在安装 Weclio Web，请稍候…');
    await withRegistry((registry) => npm(['install', '@weclio/pi-web@' + target, '--prefix', prefix, '--omit=dev', '--ignore-scripts', '--legacy-peer-deps', '--engine-strict', '--loglevel=http', ...registryArgs(registry)]), warn);
    const installed = webAt(path.join(prefix, 'node_modules/@weclio/pi-web'));
    if (!installed || installed.version !== target) throw new Error('Web 安装产物不完整');
    return await checkWebRuntime(installed);
  } catch (error) { if (current) { warn('Web 更新失败，保留并使用旧版本：' + error.message); return current; } throw error; }
}
async function installResources(sdk, options, latest, warn) {
  const agentDir = sdk.getAgentDir();
  const settings = sdk.SettingsManager.create(options.root, agentDir, { projectTrusted: false });
  const initialErrors = settings.drainErrors();
  if (initialErrors.length) throw initialErrors[0].error;
  const manager = new sdk.DefaultPackageManager({ cwd: options.root, agentDir, settingsManager: settings });
  const receiptFile = path.join(options.root, 'defaults-' + createHash('sha256').update(path.resolve(agentDir).toLowerCase()).digest('hex').slice(0, 16) + '.json');
  const receipt = readJson(receiptFile, { initialized: [] });
  if (!Array.isArray(receipt.initialized)) throw new Error('默认资源记录格式错误，不覆盖原记录。');
  const install = (name, version) => withRegistry(async (registry) => {
    settings.applyOverrides({ npmCommand: [options.node, options.npmCli, ...registryArgs(registry), '--ignore-scripts', '--omit=dev', '--loglevel=http'] });
    console.log('  安装插件或技能：' + name + '…');
    await manager.install('npm:' + name + '@' + version);
  }, warn);
  await syncResources({ settings, manager, receipt, saveReceipt: async () => writeJson(receiptFile, receipt), latest, install, warn });
  const cliDecision = resourceDecision(DEFAULTS[3], settings.getGlobalSettings().packages || [], receipt.initialized);
  if (cliDecision.action !== 'skip') {
    const cli = manager.getInstalledPath('npm:weclio-cli', 'user');
    const missing = REQUIRED_SKILLS.filter((skill) => !cli || !fs.existsSync(path.join(cli, 'skills', skill, 'SKILL.md')));
    if (missing.length) warn('当前 CLI 未提供完整 ' + REQUIRED_SKILLS.length + ' 个 skills；缺少：' + missing.join('、') + '。不会用内部同版本包覆盖。');
  }
  return agentDir;
}
function documentEnvironment(env, tools, nodeModules) {
  const result = { ...env };
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path');
  const nodePathKey = Object.keys(env).find((key) => key.toLowerCase() === 'node_path');
  for (const key of Object.keys(result)) if (['path', 'pythonhome', 'pythonpath', 'pythonnousersite', 'node_path'].includes(key.toLowerCase())) delete result[key];
  result.PATH = [...new Set(Object.values(tools).map((file) => path.dirname(file))), env[pathKey] || ''].join(path.delimiter);
  result.NODE_PATH = [nodeModules, env[nodePathKey] || ''].filter(Boolean).join(path.delimiter);
  result.PYTHONNOUSERSITE = '1';
  return result;
}
async function ensureDocumentNode(options, npm, warn) {
  const prefix = path.join(options.root, 'runtimes/document-node-9.15.0');
  const manifestFile = path.join(prefix, 'package.json');
  const manifest = readJson(manifestFile, null);
  if (manifest && (manifest.name !== 'weclio-document-runtime' || manifest.private !== true)) throw new Error('不覆盖未知文档依赖目录：' + prefix);
  const modules = path.join(prefix, 'node_modules');
  const check = async () => {
    if (readJson(path.join(modules, 'docx/package.json'), null)?.version !== '9.15.0') throw new Error('docx 版本不符合文档运行环境要求');
    await withActivity('检查 Word 创建组件', () => exec(options.node, ['-e', "const d=require('docx');if(!d.Document||!d.Packer?.toBuffer)throw Error('docx 不可用');"], {
      cwd: options.root, env: { ...process.env, NODE_PATH: modules }, windowsHide: true, timeout: 15000,
    }));
  };
  if (fs.existsSync(path.join(modules, 'docx/package.json'))) {
    try { await check(); console.log('  Word 创建组件已就绪，跳过安装。'); return modules; }
    catch (error) { warn('文档创建组件不可用，尝试重新安装：' + error.message); }
  }
  fs.mkdirSync(prefix, { recursive: true });
  if (!manifest) writeJson(manifestFile, { name: 'weclio-document-runtime', private: true });
  console.log('  安装 Word 创建组件（docx）…');
  await withRegistry((registry) => npm(['install', 'docx@9.15.0', '--prefix', prefix, '--omit=dev', '--ignore-scripts', '--legacy-peer-deps', '--engine-strict', ...registryArgs(registry)]), warn);
  await check();
  return modules;
}
async function checkDocumentRuntime(options, tools, env) {
  const directory = fs.mkdtempSync(path.join(options.root, 'document-check-'));
  const run = (message, command, args, cwd = directory) => withActivity(message, () => exec(command, args, { cwd, env, windowsHide: true, timeout: 60000, maxBuffer: 2 * 1024 * 1024 }));
  try {
    const script = path.join(directory, 'create.cjs');
    fs.writeFileSync(script, "const fs=require('node:fs');const{Document,Packer,Paragraph}=require('docx');Packer.toBuffer(new Document({sections:[{children:[new Paragraph('Weclio document runtime')]}]})).then(b=>fs.writeFileSync('sample.docx',b)).catch(e=>{console.error(e);process.exitCode=1});");
    await run('测试 Word 创建', options.node, [script]);
    await run('测试 Word 解包', tools.unzip, ['-q', 'sample.docx', '-d', 'unpacked']);
    await run('测试 Word 打包', tools.zip, ['-Xr', '../repacked.docx', '.'], path.join(directory, 'unpacked'));
    await run('测试 XML 校验', tools.python, ['-c', "import zipfile;import defusedxml.ElementTree as E;from lxml import etree;z=zipfile.ZipFile('repacked.docx');assert z.testzip() is None;xml=z.read('word/document.xml');E.fromstring(xml);etree.fromstring(xml)"]);
    await run('测试 Word 内容回读', tools.pandoc, ['repacked.docx', '-t', 'plain', '-o', 'sample.txt']);
    if (!fs.readFileSync(path.join(directory, 'sample.txt'), 'utf8').includes('Weclio document runtime')) throw new Error('Word 内容回读校验失败');
    const profile = pathToFileURL(path.join(directory, 'office-profile')).href;
    await run('测试 Word 转 PDF', tools.soffice, ['-env:UserInstallation=' + profile, '--headless', '--convert-to', 'pdf', '--outdir', directory, path.join(directory, 'repacked.docx')]);
    await run('测试 PDF 转图片', tools.pdftoppm, ['-f', '1', '-singlefile', '-jpeg', '-r', '30', 'repacked.pdf', 'page']);
    if (!fs.readFileSync(path.join(directory, 'page.jpg')).subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) throw new Error('Word 渲染校验失败');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
async function prepareDocumentRuntime(options, npm, warn) {
  console.log('[文档组件] 检查转换、校验和渲染工具…');
  const output = path.join(options.root, 'document-tools-' + randomUUID() + '.json');
  const script = "$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';try{$text=[IO.File]::ReadAllText($env:WECLIO_LAUNCHER_SOURCE,[Text.Encoding]::UTF8);$part=($text -split '(?m)^:WECLIO_POWERSHELL\\r?$')[1];Invoke-Expression $part.Substring(0,$part.LastIndexOf('try { Start-Weclio;'));$tools=Get-WeclioDocumentTools $env:WECLIO_DOCUMENT_ROOT;[IO.File]::WriteAllText($env:WECLIO_DOCUMENT_OUTPUT,($tools|ConvertTo-Json -Compress),(New-Object Text.UTF8Encoding($false)));exit 0}catch{[Console]::Error.WriteLine('文档组件准备失败：'+$_.Exception.Message);exit 1}";
  let tools;
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
        env: { ...process.env, WECLIO_LAUNCHER_SOURCE: options.source, WECLIO_DOCUMENT_ROOT: options.root, WECLIO_DOCUMENT_OUTPUT: output }, stdio: 'inherit', windowsHide: true,
      });
      child.once('error', reject);
      child.once('close', (code) => code === 0 ? resolve() : reject(new Error('文档运行环境准备失败，请重新点击脚本重试。')));
    });
    const selected = readJson(output);
    tools = Object.fromEntries(Object.keys(selected).sort().map((name) => [name, selected[name]]));
  } finally { fs.rmSync(output, { force: true }); }
  const nodeModules = await ensureDocumentNode(options, npm, warn);
  const env = documentEnvironment(process.env, tools, nodeModules);
  const receiptFile = path.join(options.root, 'document-runtime.json');
  const receipt = { version: 1, tools, nodeModules };
  if (JSON.stringify(readJson(receiptFile, null)) !== JSON.stringify(receipt)) {
    console.log('正在验证文档处理环境…');
    await checkDocumentRuntime(options, tools, env);
    writeJson(receiptFile, receipt);
  }
  // 只影响本启动器及 Web／Agent 子进程，不写永久 PATH 或用户语言环境配置。
  for (const key of Object.keys(process.env)) if (['path', 'pythonhome', 'pythonpath', 'node_path'].includes(key.toLowerCase())) delete process.env[key];
  Object.assign(process.env, env);
}
function windowsArguments(args) {
  // Start-Process 接收的是原生命令行，不经过 CMD；仅按 Windows argv 规则处理引号和反斜杠。
  return args.map((arg) => '"' + arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"').join(' ');
}
async function startServer(app, options, stateFile, agentDir) {
  const next = createRequire(path.join(app.root, 'package.json')).resolve('next/dist/bin/next');
  const port = await choosePort();
  const token = randomUUID();
  // 服务独占一个可见控制台；后台命令继承它，关窗口即停止服务，启动器本身可以退出。
  // 保留真实命令行标记，以及控制台输出的日志副本，不改变 Web／SDK 的进程调用。
  const code = [
    "const fs=require('node:fs');",
    "for(const stream of [process.stdout,process.stderr]){const write=stream.write.bind(stream);stream.write=(chunk,...args)=>{fs.appendFileSync(" + JSON.stringify(path.join(options.root, 'server.log')) + ",chunk,typeof args[0]==='string'?args[0]:undefined);return write(chunk,...args);};}",
    "process.title='Weclio Web';",
    "console.log(" + JSON.stringify('Weclio Web\nhttp://127.0.0.1:' + port + '\n\n使用期间请保持此窗口打开。\n关闭后，可双击桌面图标重新打开。') + ");",
    "const [marker,next,root,port]=process.argv.slice(1);process.argv=[process.execPath,next,'start',root,'-H','127.0.0.1','-p',port];require(next);",
  ].join('');
  const pid = Number(await powershell("$ErrorActionPreference='Stop';$p=Start-Process -FilePath $env:WECLIO_SERVER_NODE -ArgumentList $env:WECLIO_SERVER_ARGS -WorkingDirectory $env:WECLIO_SERVER_CWD -WindowStyle Normal -PassThru;$p.Id", {
    WECLIO_SERVER_NODE: options.node,
    WECLIO_SERVER_ARGS: windowsArguments(['-e', code, '--', '--weclio-instance=' + token, next, app.root, String(port)]),
    WECLIO_SERVER_CWD: app.root,
    PI_WEB_NO_OPEN: '1', PI_WEB_HOSTNAME: '127.0.0.1', PI_CODING_AGENT_DIR: agentDir,
    PATH: [path.join(agentDir, 'npm/node_modules/.bin'), process.env.PATH || process.env.Path || ''].join(path.delimiter),
  }));
  const state = { pid, port, token, node: options.node, appRoot: app.root };
  writeJson(stateFile, state);
  await waitReady(state);
  writeJson(path.join(options.root, 'current-app.json'), { root: app.root });
  return state;
}
async function main(options) {
  console.log('正在打开 Weclio Web…');
  const log = path.join(options.root, 'launcher.log');
  const warn = (message) => { console.warn(message); fs.appendFileSync(log, new Date().toISOString() + ' ' + message + os.EOL); };
  const browser = await findBrowser();
  const requestedAgentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi/agent');
  const agentDir = path.resolve(requestedAgentDir.replace(/^~(?=[\\/]|$)/, os.homedir()));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const key = createHash('sha256').update(agentDir.toLowerCase()).digest('hex').slice(0, 16);
  const stateFile = path.join(options.root, 'server-' + key + '.json');
  const state = readJson(stateFile, null);
  if (await ownedProcess(state)) {
    await waitReady(state); await shortcut(options.source, options.root, state.appRoot, warn); await openBrowser(browser, state); return;
  }
  const npm = (args, timeout) => runNpm(options, args, timeout);
  let lookupFailed = false;
  const latest = async (name) => {
    if (lookupFailed) throw new Error('本次查询源失败，余下更新延后到下次启动。');
    try { return await latestVersion(name, npm, warn); }
    catch (error) { lookupFailed = true; throw error; }
  };
  console.log('[Web 程序] 检查版本和更新…');
  const app = await ensureWeb(options.root, npm, latest, warn);
  await prepareDocumentRuntime(options, npm, warn);
  // 核心 SDK 必须能加载；不能将核心损坏降级为默认资源告警。
  const sdk = await import(sdkUrl(app));
  console.log('[默认资源] 检查插件和技能…');
  try { await installResources(sdk, options, latest, warn); }
  catch (error) { warn('默认资源检查未完成，保留原配置并继续打开 Web：' + error.message); }
  console.log('[启动服务] 等待本地 Web 服务就绪…');
  const started = await startServer(app, options, stateFile, agentDir);
  await shortcut(options.source, options.root, app.root, warn);
  await openBrowser(browser, started);
}
module.exports = { withActivity, REGISTRIES, DEFAULTS, registryArgs, shortcut, runNpm, withRegistry, latestVersion, versionAfter, resourceDecision, syncResources, installResources, documentEnvironment, ensureDocumentNode, checkDocumentRuntime, prepareDocumentRuntime, browserCandidates, isOwnedProcess, isOwnedListener, choosePort, ensureWeb, webAt, checkWebRuntime, windowsArguments, startServer, ownedProcess, ready, httpReady, powershell };
if (process.argv[1] === '--weclio-launcher') {
  const [, , node, npmCli, source, root] = process.argv;
  main({ node, npmCli, source, root }).catch((error) => {
    console.error('启动失败：' + error.message + '\n日志目录：' + root);
    process.exitCode = 1;
  });
}

:WECLIO_POWERSHELL
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

function Invoke-WithActivity([string]$Message, [scriptblock]$Action, [string]$File = '') {
    if (!('WeclioInstallActivity' -as [type])) {
        # 计时器只写控制台，不在线程池里执行 PowerShell 安装逻辑。
        Add-Type -TypeDefinition @'
using System;
using System.Threading;
using System.Diagnostics;
using System.IO;
public sealed class WeclioInstallActivity : IDisposable {
    private readonly object gate = new object();
    private readonly string message;
    private readonly string file;
    private readonly Stopwatch watch = Stopwatch.StartNew();
    private readonly Timer timer;
    private long bytes;
    private bool stopped;
    private int frame;
    public WeclioInstallActivity(string message, string file) {
        this.message = message;
        this.file = file;
        Console.Write(Text("..."));
        timer = new Timer(Draw, null, 500, 500);
    }
    private string Text(string dots) {
        if (string.IsNullOrEmpty(file)) return message + dots;
        // 临时文件可能在失败时被移除；保留最后读到的进度，错误仍由下载命令报告。
        try { if (File.Exists(file)) bytes = Math.Max(bytes, new FileInfo(file).Length); }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
        return string.Format("{0} 已下载 {1,8:F1} MB（已用 {2,4} 秒）{3}", message, bytes / 1048576.0, (int)watch.Elapsed.TotalSeconds, dots);
    }
    private void Draw(object state) {
        lock (gate) {
            if (!stopped) Console.Write("\r" + Text(new string('.', frame++ % 3 + 1).PadRight(3)));
        }
    }
    public void Dispose() {
        lock (gate) {
            if (stopped) return;
            stopped = true;
            timer.Dispose();
            Console.Write("\r" + Text("...") + Environment.NewLine);
        }
    }
}
'@
    }
    $activity = New-Object WeclioInstallActivity -ArgumentList @(('  ' + $Message), $File)
    try { & $Action } finally { $activity.Dispose() }
}
function Get-CheckedFile([string[]]$Urls, [string]$Target, [string]$Sha256, [string]$Label = '', [int]$TimeoutSeconds = 180) {
    if (!$Label) { $Label = [IO.Path]::GetFileName($Target) }
    if ((Test-Path -LiteralPath $Target) -and (Get-FileHash -LiteralPath $Target -Algorithm SHA256).Hash -eq $Sha256) {
        [Console]::WriteLine('  使用已校验的缓存：' + $Label)
        return
    }
    $partial = $Target + '.' + [guid]::NewGuid().ToString('N') + '.part'
    foreach ($url in $Urls) {
        try {
            [Console]::WriteLine('  正在下载 ' + $Label + '…')
            Invoke-WithActivity ('下载 ' + $Label) { Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $partial -TimeoutSec $TimeoutSeconds } $partial
            [Console]::WriteLine('  下载完成，正在校验 ' + $Label + '…')
            if ((Get-FileHash -LiteralPath $partial -Algorithm SHA256).Hash -ne $Sha256) { throw 'SHA256 校验失败' }
            Move-Item -LiteralPath $partial -Destination $Target -Force
            [Console]::WriteLine('  ' + $Label + ' 校验通过。')
            return
        } catch {
            if (Test-Path -LiteralPath $partial) { Remove-Item -LiteralPath $partial -Force }
            [Console]::WriteLine('  下载源失败（' + $url + '）：' + $_.Exception.Message)
        }
    }
    throw '运行依赖下载失败；请检查网络后重新点击同一脚本。'
}
function Test-NodePair([string]$Node, [string]$NpmCli) {
    if (!(Test-Path -LiteralPath $Node) -or !(Test-Path -LiteralPath $NpmCli)) { return $false }
    try {
        & $Node -e 'const v=process.versions.node.split(''.'').map(Number);process.exit(v[0]>22||(v[0]===22&&v[1]>=19)?0:1)' 2>$null
        if ($LASTEXITCODE -ne 0) { return $false }
        $version = & $Node $NpmCli --version --update-notifier=false 2>$null
        return $LASTEXITCODE -eq 0
    } catch { return $false }
}
function Get-WeclioNode([string]$Root) {
    $privateNode = Join-Path $Root 'runtimes\node-v24.22.1-win-x64\node.exe'
    $nodes = @((Get-Command node.exe -All -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source)) + @($privateNode)
    $npmDirectories = @(Get-Command npm.cmd -All -ErrorAction SilentlyContinue | ForEach-Object { Split-Path $_.Source })
    foreach ($node in $nodes) {
        foreach ($directory in @((Split-Path $node)) + $npmDirectories) {
            $npmCli = Join-Path $directory 'node_modules\npm\bin\npm-cli.js'
            if (Test-NodePair $node $npmCli) { [Console]::WriteLine('  Node.js 已就绪，跳过下载。'); return @($node, $npmCli) }
        }
    }
    $archive = Join-Path $Root 'downloads\node-v24.22.1-win-x64.zip'
    Get-CheckedFile @('https://registry.npmmirror.com/-/binary/node/v24.22.1/node-v24.22.1-win-x64.zip', 'https://nodejs.org/dist/v24.22.1/node-v24.22.1-win-x64.zip') $archive 'd2046d28c2c3dcd211ac5145c0bf30e2047ef9dfb306693c8c6e2eccd8b95fa5'
    $tar = Join-Path $env:SystemRoot 'System32\tar.exe'
    Invoke-WithActivity '解压 Node.js' {
        if (Test-Path -LiteralPath $tar) {
            & $tar -xf $archive -C (Join-Path $Root 'runtimes')
            if ($LASTEXITCODE -ne 0) { throw 'Node 归档解压失败，请重新点击脚本重试。' }
        } else { Expand-Archive -LiteralPath $archive -DestinationPath (Join-Path $Root 'runtimes') -Force }
    }
    $npmCli = Join-Path (Split-Path $privateNode) 'node_modules\npm\bin\npm-cli.js'
    if (!(Test-NodePair $privateNode $npmCli)) { throw '用户目录中的 Node/npm 未能就绪。' }
    return @($privateNode, $npmCli)
}
function Complete-PortableGit([string]$Directory) {
    if (Test-Path -LiteralPath (Join-Path $Directory 'post-install.bat')) {
        Invoke-WithActivity '初始化 Git Bash' { Start-Process -FilePath (Join-Path $Directory 'git-bash.exe') -WorkingDirectory $Directory -ArgumentList '--no-needs-console --hide --no-cd --command=post-install.bat' -Wait }
        if (Test-Path -LiteralPath (Join-Path $Directory 'post-install.bat')) { throw 'PortableGit 初始化未完成，请重新点击脚本重试。' }
    }
}
function Get-WeclioGit([string]$Root) {
    $candidates = @((Get-Command git.exe -All -ErrorAction SilentlyContinue | ForEach-Object { Split-Path (Split-Path $_.Source) }))
    foreach ($base in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA)) {
        if ($base) { $candidates += (Join-Path $base 'Git'); $candidates += (Join-Path $base 'Programs\Git') }
    }
    $privateGit = Join-Path $Root 'runtimes\git-2.56.0.4'
    $candidates += $privateGit
    foreach ($candidate in $candidates) {
        if ((Test-Path -LiteralPath (Join-Path $candidate 'cmd\git.exe')) -and (Test-Path -LiteralPath (Join-Path $candidate 'bin\bash.exe'))) {
            try {
                if ($candidate -eq $privateGit) { Complete-PortableGit $candidate }
                $gitVersion = & (Join-Path $candidate 'cmd\git.exe') --version 2>$null
                if ($LASTEXITCODE -ne 0) { continue }
                $bashVersion = & (Join-Path $candidate 'bin\bash.exe') --version 2>$null
                if ($LASTEXITCODE -eq 0) { [Console]::WriteLine('  Git Bash 已就绪，跳过下载。'); return $candidate }
            } catch { Write-Host '已有 Git 环境不可用，尝试其他位置或用户目录安装。' }
        }
    }
    $archive = Join-Path $Root 'downloads\PortableGit-2.56.0.4-64-bit.7z.exe'
    Get-CheckedFile @('https://registry.npmmirror.com/-/binary/git-for-windows/v2.56.0.windows.4/PortableGit-2.56.0.4-64-bit.7z.exe', 'https://github.com/git-for-windows/git/releases/download/v2.56.0.windows.4/PortableGit-2.56.0.4-64-bit.7z.exe') $archive 'b1f3e52216e2ed6882d1bebfd4d3fdf319bec40d2edbbf9fd26ec4fd3fce7ed1'
    # 使用经摘要验证的官方便携自解压包；-o 指向本用户目录，不注册系统安装。
    $extract = Invoke-WithActivity '解压 Git Bash' { Start-Process -FilePath $archive -ArgumentList ('-y -o"' + $privateGit + '"') -Wait -PassThru }
    if ($null -ne $extract.ExitCode -and $extract.ExitCode -ne 0) { throw 'Git 解压失败，请重新点击脚本重试。' }
    Complete-PortableGit $privateGit
    $gitVersion = & (Join-Path $privateGit 'cmd\git.exe') --version
    if ($LASTEXITCODE -ne 0 -or !(Test-Path -LiteralPath (Join-Path $privateGit 'bin\bash.exe'))) { throw '用户目录中的 Git Bash 未能就绪。' }
    return $privateGit
}
function Test-DocumentCommand([string]$File, [string[]]$Arguments, [string]$Pattern) {
    if (!$File -or !(Test-Path -LiteralPath $File) -or $File -like '*\WindowsApps\*') { return $false }
    $ErrorActionPreference = 'Continue'
    try { $output = & $File @Arguments 2>&1; return $LASTEXITCODE -eq 0 -and (($output | Out-String) -match $Pattern) }
    catch { return $false }
}
function Expand-DocumentArchive([string]$Root, [string]$Name, [string[]]$Urls, [string]$Sha256, [string]$Destination) {
    $archive = Join-Path $Root ('downloads\' + $Name + '.zip')
    Get-CheckedFile $Urls $archive $Sha256
    Invoke-WithActivity ('解压 ' + $Name) { Expand-Archive -LiteralPath $archive -DestinationPath $Destination -Force }
}
function Get-DocumentPython([string]$Root) {
    $directory = Join-Path $Root 'runtimes\python-3.13.17'
    $python = Join-Path $directory 'tools\python.exe'
    $check = 'import sys;assert (3,10)<=sys.version_info;import defusedxml,lxml.etree;assert tuple(map(int,defusedxml.__version__.split(''.'')))>=(0,7,1);assert lxml.etree.LXML_VERSION>=(6,1,3,0);print(''ready'')'
    $candidates = @(Get-Command python.exe -All -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source) + @($python)
    foreach ($candidate in $candidates) { if (Test-DocumentCommand $candidate @('-I','-c',$check) 'ready') { [Console]::WriteLine('  Python 与 XML 校验库已就绪，跳过安装。'); return $candidate } }
    # 不向用户现有 Python 装包；缺失依赖时使用 PSF 的可解压发行包及其私有 site-packages。
    if (!(Test-DocumentCommand $python @('-I','-c','import pip;print(''ready'')') 'ready')) {
        Expand-DocumentArchive $Root 'python-3.13.17' @('https://api.nuget.org/v3-flatcontainer/python/3.13.17/python.3.13.17.nupkg','https://www.nuget.org/api/v2/package/python/3.13.17') 'dce409744b088f94c6e37ba41f8100c384c27e029e843237364c602d30d475e5' $directory
    }
    [Console]::WriteLine('  安装 Python XML 校验库（defusedxml、lxml）…')
    foreach ($index in @('https://pypi.tuna.tsinghua.edu.cn/simple','https://pypi.org/simple')) {
        & $python -I -m pip --isolated install --disable-pip-version-check --no-input --only-binary=:all: --index-url $index 'defusedxml==0.7.1' 'lxml==6.1.3' | Out-Host
        if ($LASTEXITCODE -eq 0 -and (Test-DocumentCommand $python @('-I','-c',$check) 'ready')) { return $python }
        [Console]::WriteLine('Python 依赖源不可用或安装失败，尝试下一来源。')
    }
    throw '文档 Python 依赖未能就绪，请检查网络后重试。'
}
function Get-WeclioDocumentTools([string]$Root) {
    $tools = @{python=(Get-DocumentPython $Root)}
    $specs = @(
        @{name='pandoc'; label='文档转换工具（Pandoc）'; argument='--version'; pattern='pandoc [3-9]\.'; directory='pandoc-3.13'; executable='pandoc-3.13\pandoc.exe'; hash='23e1f2e978a3df80db8bf65c9c59534f41a23140480cfb4f783a882ab7dc6a4e'; urls=@('https://github.com/jgm/pandoc/releases/download/3.13/pandoc-3.13-windows-x86_64.zip')},
        @{name='pdftoppm'; label='PDF 转图片工具（Poppler）'; argument='-v'; pattern='pdftoppm version'; directory='poppler-26.09.0'; executable='poppler-26.09.0\Library\bin\pdftoppm.exe'; hash='7a6f256a0ddf7536182246a5733331bf4677cbcc34f4663774947ad34556c8d0'; urls=@('https://github.com/oschwartz10612/poppler-windows/releases/download/v26.09.0-0/Release-26.09.0-0.zip')},
        @{name='zip'; label='ZIP 打包工具'; argument='-v'; pattern='Zip 3\.'; directory='zip-3.0'; executable='bin\zip.exe'; hash='291c7404c728e0714fc95148b526ce471bdc09c45a65a4e0c51bff4a00825ad2'; urls=@('https://downloads.sourceforge.net/gnuwin32/zip-3.0-bin.zip','https://twds.dl.sourceforge.net/project/gnuwin32/zip/3.0/zip-3.0-bin.zip')}
    )
    foreach ($spec in $specs) {
        $destination = Join-Path $Root ('runtimes\' + $spec.directory)
        $private = Join-Path $destination $spec.executable
        $selected = $null
        $candidates = @(Get-Command ($spec.name + '.exe') -All -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source) + @($private)
        foreach ($candidate in $candidates) { if (Test-DocumentCommand $candidate @($spec.argument) $spec.pattern) { $selected = $candidate; break } }
        $reused = [bool]$selected
        if (!$selected) {
            Expand-DocumentArchive $Root $spec.directory $spec.urls $spec.hash $destination
            if ($spec.name -eq 'zip') { Expand-DocumentArchive $Root 'zip-3.0-dep' @('https://downloads.sourceforge.net/gnuwin32/zip-3.0-dep.zip','https://twds.dl.sourceforge.net/project/gnuwin32/zip/3.0/zip-3.0-dep.zip') '2e60c455e06664ac633507d2d4ccda6a09b78f59a9b70e82201d2c5e8b9305d2' $destination }
            if (!(Test-DocumentCommand $private @($spec.argument) $spec.pattern)) { throw ('文档工具未能运行：' + $spec.name) }
            $selected = $private
        }
        $tools[$spec.name] = $selected
        $status = if ($reused) { ' 已就绪，跳过下载。' } else { ' 已就绪。' }
        [Console]::WriteLine('  ' + $spec.label + $status)
    }
    $unzip = @(Get-Command unzip.exe -All -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source | Where-Object { Test-DocumentCommand $_ @('-v') 'UnZip [6-9]\.' })
    if (!$unzip.Count) { throw 'Git Bash 未提供可用的 unzip，请检查 Git 环境后重试。' }
    $tools.unzip = $unzip[0]
    $office = Join-Path $Root 'runtimes\libreoffice-26.8.2'
    $candidates = @(Get-Command soffice.com -All -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source)
    foreach ($base in @($env:ProgramFiles, ${env:ProgramFiles(x86)})) { if ($base) { $candidates += (Join-Path $base 'LibreOffice\program\soffice.com') } }
    $candidates += (Join-Path $office 'program\soffice.com')
    foreach ($candidate in $candidates) { if (Test-DocumentCommand $candidate @('--version') 'LibreOffice') { $tools.soffice = $candidate; break } }
    if ($tools.soffice) { [Console]::WriteLine('  LibreOffice 已就绪，跳过下载。') }
    if (!$tools.soffice) {
        $archive = Join-Path $Root 'downloads\libreoffice-26.8.2.msi'
        Get-CheckedFile @('https://download.documentfoundation.org/libreoffice/stable/26.8.2/win/x86_64/LibreOffice_26.8.2_Win_x86-64.msi','https://downloadarchive.documentfoundation.org/libreoffice/old/26.8.2.2/win/x86_64/LibreOffice_26.8.2.2_Win_x86-64.msi') $archive 'ff4b911403b67ee9e6249f820f9782c44bb32c94fdaa45b0da53a8e419e5307a'
        # /a 只展开用户目录中的管理映像，不注册 Office、不更改文件关联或请求提权。
        $extract = Invoke-WithActivity '解压安装 LibreOffice（文件较大，请勿关闭窗口）' { Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\msiexec.exe') -ArgumentList ('/a "' + $archive + '" /qn TARGETDIR="' + $office + '" /l*v "' + (Join-Path $Root 'document-office-install.log') + '"') -Wait -PassThru }
        if ($extract.ExitCode -ne 0) { throw ('LibreOffice 用户目录展开失败：' + $extract.ExitCode + '；请查看 document-office-install.log。') }
        # 管理映像把 VC 运行库放在 System64；复制到私有 program，避免依赖系统级安装。
        Get-ChildItem -LiteralPath (Join-Path $office 'System64') -Filter '*.dll' | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $office 'program') -Force }
        $tools.soffice = Join-Path $office 'program\soffice.com'
        if (!(Test-DocumentCommand $tools.soffice @('--version') 'LibreOffice')) { throw 'LibreOffice 文档处理组件未能就绪。' }
    }
    return $tools
}
function Start-Weclio {
    if (![Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { throw '此启动器目前支持 Windows x64。' }
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $mutex = New-Object Threading.Mutex($false, ('Local\WeclioWebLauncher-' + $sid))
    $held = $false
    try {
        try { $held = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $held = $true }
        if (!$held) { Write-Host '已有安装或启动正在进行，请等待当前窗口完成。'; return }
        $root = Join-Path $env:LOCALAPPDATA 'WeclioWeb'
        foreach ($directory in @($root, (Join-Path $root 'downloads'), (Join-Path $root 'runtimes'))) { [void](New-Item -ItemType Directory -Path $directory -Force) }
        [Console]::WriteLine('[基础环境] 检查 Node.js 和 Git…')
        $pair = @(Get-WeclioNode $root)
        $git = Get-WeclioGit $root
        # 仅本次进程及其子进程可见，不更改系统/用户 PATH、npm prefix 或 npmrc。
        $npmBin = Split-Path (Split-Path (Split-Path (Split-Path $pair[1])))
        $env:PATH = (Split-Path $pair[0]) + ';' + $npmBin + ';' + (Join-Path $git 'cmd') + ';' + (Join-Path $git 'bin') + ';' + (Join-Path $git 'usr\bin') + ';' + $env:PATH
        $entry = 'const fs=require(''node:fs'');const text=fs.readFileSync(process.env.WECLIO_LAUNCHER_SOURCE,''utf8'');const code=text.split(/\r?\n:WECLIO_NODE\r?\n/)[1].split(/\r?\n:WECLIO_POWERSHELL\r?\n/)[0];new Function(''require'',''module'',''exports'',code)(require,module,exports);'
        & $pair[0] -e $entry -- '--weclio-launcher' $pair[0] $pair[1] $env:WECLIO_LAUNCHER_SOURCE $root
        if ($LASTEXITCODE -ne 0) { throw ('启动未完成；日志目录：' + $root) }
    } finally {
        if ($held) { $mutex.ReleaseMutex() }
        $mutex.Dispose()
    }
}
try { Start-Weclio; exit 0 } catch { Write-Host ('Weclio Web：' + $_.Exception.Message) -ForegroundColor Red; exit 1 }
