import assert from "node:assert/strict";
import { readFile, readdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import test from "node:test";

const sourceFile = fileURLToPath(new URL("../launch-weclio-web.bat", import.meta.url));
const source = await readFile(sourceFile, "utf8");
const code = source.split(/\r?\n:WECLIO_NODE\r?\n/)[1].split(/\r?\n:WECLIO_POWERSHELL\r?\n/)[0];
const subject = { exports: {} };
new Function("require", "module", "exports", code)(createRequire(import.meta.url), subject, subject.exports);
const launcher = subject.exports;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

for (const fails of [false, true]) test(`single-line activity stops after ${fails ? "failure" : "success"}`, async () => {
  const messages = [];
  const local = { exports: {} };
  const isolatedProcess = Object.create(process);
  Object.defineProperty(isolatedProcess, "stdout", { value: { write: (message) => { messages.push(message); return true; } } });
  new Function("require", "module", "exports", "process", code)(createRequire(import.meta.url), local, local.exports, isolatedProcess);
  const operation = local.exports.withActivity("测试安装", async () => {
    await delay(70);
    if (fails) throw new Error("fixture failure");
    return 42;
  }, 20);
  if (fails) await assert.rejects(operation, /fixture failure/);
  else assert.equal(await operation, 42);
  assert.ok(messages.filter((message) => message.startsWith("\r") && message.includes("测试安装")).length > 1);
  assert.equal(messages.filter((message) => message.includes("\n")).length, 1);
  assert.ok(messages.every((message) => !/秒|仍在/.test(message)));
  const finishedCount = messages.length;
  await delay(50);
  assert.equal(messages.length, finishedCount);
});

async function download(t, server, urls, bytes, { timeout = 180, onOutput = () => {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), "weclio-progress-test-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const script = "$ProgressPreference='SilentlyContinue';$text=[IO.File]::ReadAllText($env:WECLIO_SOURCE,[Text.Encoding]::UTF8);$part=($text -split '(?m)^:WECLIO_POWERSHELL\\r?$')[1];Invoke-Expression $part.Substring(0,$part.LastIndexOf('try { Start-Weclio;'));$urls=$env:WECLIO_URLS -split '\\|';Get-CheckedFile $urls $env:WECLIO_TARGET $env:WECLIO_HASH '测试组件' ([int]$env:WECLIO_TIMEOUT);Get-CheckedFile $urls $env:WECLIO_TARGET $env:WECLIO_HASH '测试组件';exit 0";
  const file = join(root, "下载 中文 空格.zip");
  const child = spawn(join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"), ["-NoProfile", "-NonInteractive", "-OutputFormat", "Text", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
    env: { ...process.env, WECLIO_SOURCE: sourceFile, WECLIO_URLS: urls.map((path) => origin + path).join("|"), WECLIO_TARGET: file, WECLIO_HASH: createHash("sha256").update(bytes).digest("hex"), WECLIO_TIMEOUT: String(timeout), PSModuleAnalysisCachePath: join(root, "module-cache") },
    windowsHide: true,
  });
  let output = "", errors = "";
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { output += chunk; onOutput(chunk); });
  child.stderr.on("data", (chunk) => { errors += chunk; });
  const deadline = setTimeout(() => child.kill(), 30000);
  try {
    await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => code === 0 ? resolve() : reject(new Error(errors || output)));
    });
  } finally { clearTimeout(deadline); }
  assert.deepEqual(await readFile(file), bytes);
  assert.ok((await readdir(root)).every((name) => !name.endsWith(".part")));
  assert.match(output, /测试组件/);
  assert.match(output, /校验通过/);
  assert.match(output, /使用已校验的缓存/);
  assert.doesNotMatch(output, /\d+%/);
  return output;
}

test("a slow download reports actual transferred bytes before completion and a cached rerun makes no request", { skip: process.platform !== "win32" }, async (t) => {
  const chunk = Buffer.alloc(32 * 1024, 97);
  const bytes = Buffer.concat(Array(8).fill(chunk));
  let completed = false, progressWhileDownloading = false, calls = 0;
  const server = createServer((request, response) => {
    calls++;
    response.setHeader("Content-Length", bytes.length);
    let sent = 0;
    const timer = setInterval(() => {
      response.write(chunk);
      if (++sent === 8) { completed = true; clearInterval(timer); response.end(); }
    }, 1000);
    response.on("close", () => clearInterval(timer));
  });
  const output = await download(t, server, ["/slow"], bytes, { onOutput: (chunk) => { if (chunk.includes("已下载") && !completed) progressWhileDownloading = true; } });
  assert.ok(progressWhileDownloading);
  assert.match(output, /已下载\s+[\d.]+ MB.*已用\s+\d+ 秒/);
  assert.ok(output.split(/\r(?!\n)/).length > 2);
  assert.ok(!output.includes("\\r"));
  assert.equal(calls, 1);
});

test("PowerShell activity refreshes one line and stops on success and failure", { skip: process.platform !== "win32" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "weclio-activity-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = "$ProgressPreference='SilentlyContinue';$text=[IO.File]::ReadAllText($env:WECLIO_SOURCE,[Text.Encoding]::UTF8);$part=($text -split '(?m)^:WECLIO_POWERSHELL\\r?$')[1];Invoke-Expression $part.Substring(0,$part.LastIndexOf('try { Start-Weclio;'));Invoke-WithActivity '成功测试' {Start-Sleep -Milliseconds 1100};try{Invoke-WithActivity '失败测试' {Start-Sleep -Milliseconds 600;throw 'expected'}}catch{if($_.Exception.Message -ne 'expected'){throw}};[Console]::WriteLine('finished');Start-Sleep -Milliseconds 700";
  const output = await launcher.powershell(script, { WECLIO_SOURCE: sourceFile, PSModuleAnalysisCachePath: join(root, "module-cache") });
  assert.ok(output.split("\r").length > 4);
  assert.match(output, /成功测试/);
  assert.match(output, /失败测试/);
  assert.ok(output.endsWith("finished"));
  assert.doesNotMatch(output, /仍在|已用 \d+ 秒/);
});

test("activity wrapping preserves archive scope and native process exit codes", { skip: process.platform !== "win32" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "weclio-activity-scope-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = "$ProgressPreference='SilentlyContinue';$text=[IO.File]::ReadAllText($env:WECLIO_SOURCE,[Text.Encoding]::UTF8);$part=($text -split '(?m)^:WECLIO_POWERSHELL\\r?$')[1];Invoke-Expression $part.Substring(0,$part.LastIndexOf('try { Start-Weclio;'));Add-Type -AssemblyName System.IO.Compression.FileSystem;$inputDir=Join-Path $env:WECLIO_ROOT 'input';$downloads=Join-Path $env:WECLIO_ROOT 'downloads';[void][IO.Directory]::CreateDirectory($inputDir);[void][IO.Directory]::CreateDirectory($downloads);[IO.File]::WriteAllText((Join-Path $inputDir 'payload.txt'),'fixture');[IO.Compression.ZipFile]::CreateFromDirectory($inputDir,(Join-Path $downloads 'fixture.zip'));function Get-CheckedFile{};$destination=Join-Path $env:WECLIO_ROOT '解压 中文 & %!';Expand-DocumentArchive $env:WECLIO_ROOT 'fixture' @('unused') 'unused' $destination;if([IO.File]::ReadAllText((Join-Path $destination 'payload.txt')) -ne 'fixture'){throw 'archive scope changed'};$process=Invoke-WithActivity '测试进程' {Start-Process -FilePath $env:WECLIO_NODE -ArgumentList '-e process.exit(7)' -NoNewWindow -Wait -PassThru};if($process.ExitCode -ne 7){throw 'process exit code changed'};[Console]::WriteLine('scope-ok')";
  const output = await launcher.powershell(script, { WECLIO_SOURCE: sourceFile, WECLIO_ROOT: root, WECLIO_NODE: process.execPath, PSModuleAnalysisCachePath: join(root, "module-cache") });
  assert.ok(output.endsWith("scope-ok"));
});

test("an HTTP failure falls back without reporting the failed source as verified", { skip: process.platform !== "win32" }, async (t) => {
  const bytes = Buffer.from("verified HTTP fallback");
  const calls = [];
  const server = createServer((request, response) => {
    calls.push(request.url);
    if (request.url === "/error") { response.statusCode = 503; response.end("unavailable"); }
    else response.end(bytes);
  });
  const output = await download(t, server, ["/error", "/ok"], bytes);
  assert.deepEqual(calls, ["/error", "/ok"]);
  assert.match(output, /下载源失败/);
  assert.equal(output.split("校验通过").length - 1, 1);
});

test("a request timeout falls back and leaves no partial files", { skip: process.platform !== "win32" }, async (t) => {
  const bytes = Buffer.from("verified fallback archive");
  const calls = [];
  const server = createServer((request, response) => {
    calls.push(request.url);
    if (request.url === "/fast") { response.end(bytes); return; }
    const timer = setTimeout(() => response.end("late"), 5000);
    response.on("close", () => clearTimeout(timer));
  });
  const output = await download(t, server, ["/slow", "/fast"], bytes, { timeout: 1 });
  assert.deepEqual(calls, ["/slow", "/fast"]);
  assert.match(output, /超时|timed out/i);
});
