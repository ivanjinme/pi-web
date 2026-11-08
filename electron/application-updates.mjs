import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { applicationManifestUrl, compareVersions, compatibleApplication, LIMITS, validateLayout, verifyApplicationManifest } from "./application-manifest.mjs";
import { prepareApplication, readPreparedApplication } from "./application-store.mjs";
import { updateUrl } from "./update-signature.mjs";

function safeUrl(value, devFixture) {
  const url = updateUrl(String(value), devFixture);
  if (url.protocol === "http:" && url.hostname !== "127.0.0.1") throw new Error("Unsafe application update URL");
  return url;
}

async function request(url, { fetch, signal, devFixture }) {
  url = safeUrl(url, devFixture);
  for (let redirects = 0; ; redirects++) {
    signal.throwIfAborted();
    const response = await fetch(url, { redirect: "manual", signal });
    signal.throwIfAborted();
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location || redirects >= 5) throw new Error("Invalid application update redirect");
    url = safeUrl(new URL(location, url), devFixture);
  }
}

async function canonicalDirectory(location) {
  const absolute = path.resolve(location);
  // 先检查祖先，避免递归 mkdir 通过链接在存储区外创建目录。
  try {
    const info = await lstat(absolute);
    if (!info.isDirectory() || info.isSymbolicLink() || path.relative(absolute, await realpath(absolute)) !== "") throw new Error("Application downloads require canonical non-linked directories");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await canonicalDirectory(path.dirname(absolute));
    await mkdir(absolute);
    await canonicalDirectory(absolute);
  }
}

export function createApplicationUpdateService({ config, shell, selection, storeRoot, toolsRoot, toolsetManifest, apply, publish = () => {}, log = console.error, installEnabled = false, fetch = globalThis.fetch, readPrepared = readPreparedApplication, prepare = prepareApplication }) {
  const manifestUrl = applicationManifestUrl(config?.manifestUrl instanceof URL ? config.manifestUrl.href : config?.manifestUrl, config?.devFixture);
  const abort = new AbortController();
  let state = { status: "idle" };
  let stopped = false;
  let checking;
  let ready;
  let verifiedForInstall = false;
  let lastProgress = 0;
  const change = (next) => {
    if (stopped) return;
    state = next;
    publish({ ...state });
  };
  const report = (version, phase, progress) => {
    const now = Date.now();
    const bounded = Number.isFinite(progress) ? Math.max(0, Math.min(100, progress)) : undefined;
    if (state.phase === phase && bounded !== 100 && now - lastProgress < 250) return;
    if (state.phase === phase && state.progress === bounded) return;
    lastProgress = now;
    change({ status: phase === "download" ? "downloading" : "preparing", version, phase, ...(bounded === undefined ? {} : { progress: bounded }) });
  };
  const optionsFor = (id, signal = abort.signal) => ({ storeRoot, id, key: config.key, shell, devFixture: config.devFixture, signal });
  const newer = (record) => {
    const current = selection.getCurrent();
    return record.id !== current.failed && compareVersions(record.version, current.version) > 0;
  };
  const revoke = () => { ready = undefined; verifiedForInstall = false; };
  const failed = (error, version) => {
    revoke();
    if (!stopped) {
      log("[application-update]", error);
      // 不将包含本机路径的存储/解压异常传入 renderer。
      change({ status: "error", ...(version ? { version } : {}) });
    }
  };

  async function manifest() {
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]);
    const response = await request(manifestUrl, { fetch, signal, devFixture: config.devFixture });
    if (response.status === 404) { await response.body?.cancel(); return null; }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Application manifest HTTP ${response.status}`); }
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      signal.throwIfAborted();
      size += chunk.length;
      if (size > 2 * LIMITS.manifestBytes) throw new Error("Application manifest too large");
      chunks.push(chunk);
    }
    signal.throwIfAborted();
    const envelope = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
    return { envelope, release: verifyApplicationManifest(envelope, config.key, config.devFixture) };
  }

  async function download(expected, destination, version, completed, total) {
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15 * 60_000)]);
    const response = await request(expected.url, { fetch, signal, devFixture: config.devFixture });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Application artifact HTTP ${response.status}`); }
    let handle;
    try {
      handle = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
      let size = 0;
      const hash = createHash("sha512");
      for await (const chunk of response.body) {
        signal.throwIfAborted();
        size += chunk.length;
        if (size > expected.size) throw new Error("Application artifact too large");
        hash.update(chunk);
        await handle.writeFile(chunk);
        report(version, "download", 100 * (completed + size) / total);
      }
      signal.throwIfAborted();
      if (size !== expected.size || hash.digest("base64") !== expected.sha512) throw new Error("Application artifact size or SHA512 mismatch");
    } finally {
      if (handle) await handle.close();
      else await response.body?.cancel();
    }
  }

  async function runCheck() {
    let version;
    let temporary;
    try {
      change({ status: "checking" });
      const result = await manifest();
      abort.signal.throwIfAborted();
      if (!result) { change({ status: "idle" }); return; }
      const { envelope, release } = result;
      if (!newer(release) || !compatibleApplication(release, shell)) { change({ status: "idle" }); return; }
      version = release.version;
      let record;
      try {
        record = await readPrepared(optionsFor(release.id));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      abort.signal.throwIfAborted();
      if (!record) {
        if (typeof storeRoot !== "string" || !path.isAbsolute(storeRoot)) throw new Error("An absolute application storeRoot is required");
        await canonicalDirectory(storeRoot);
        const downloads = path.join(storeRoot, "downloads");
        await canonicalDirectory(downloads);
        abort.signal.throwIfAborted();
        temporary = await mkdtemp(path.join(downloads, ".partial-"));
        await canonicalDirectory(temporary);
        const layoutPath = path.join(temporary, "layout.json");
        const archivePath = path.join(temporary, "application.zip");
        const total = release.layout.size + release.archive.size;
        report(version, "download", 0);
        await download(release.layout, layoutPath, version, 0, total);
        validateLayout(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readFile(layoutPath))), release);
        await download(release.archive, archivePath, version, release.layout.size, total);
        abort.signal.throwIfAborted();
        report(version, "extracting");
        record = await prepare({ ...optionsFor(release.id), envelope, toolsRoot, toolsetManifest, layoutPath, archivePath,
          onProgress: ({ phase, completedBytes, totalBytes }) => {
            if (phase === "extracting" || phase === "verifying") report(version, phase, totalBytes > 0 ? completedBytes / totalBytes * 100 : undefined);
          },
        });
      }
      abort.signal.throwIfAborted();
      if (record.id !== release.id || record.version !== release.version) throw new Error("Prepared application identity mismatch");
      if (!newer(record)) { change({ status: "idle" }); return; }
      ready = { id: record.id, version: record.version };
      verifiedForInstall = false;
      change({ status: "downloaded", version, kind: "application" });
    } catch (error) {
      failed(error, version);
    } finally {
      if (temporary) {
        try { await rm(temporary, { recursive: true, force: true }); }
        catch (error) { if (!stopped) log("[application-update] cleanup", error); }
      }
    }
  }

  const canInstall = () => installEnabled && !stopped && !!ready && state.status === "downloaded";
  function check() {
    if (stopped || ready || !manifestUrl) return Promise.resolve();
    if (!checking) checking = Promise.resolve().then(runCheck).finally(() => { checking = undefined; });
    return checking;
  }
  return {
    getState: () => ({ ...state }),
    check,
    canInstall,
    async verifyForInstall() {
      verifiedForInstall = false;
      if (!canInstall()) throw new Error("Application update is download-only");
      const candidate = ready;
      try {
        const record = await readPrepared(optionsFor(candidate.id));
        abort.signal.throwIfAborted();
        if (record.id !== candidate.id || record.version !== candidate.version || !newer(record)) throw new Error("Application update is no longer eligible for installation");
        verifiedForInstall = true;
      } catch (error) {
        failed(error, candidate.version);
        throw error;
      }
    },
    onInstallError() { return () => {}; },
    async quitAndInstall() {
      if (!canInstall() || !verifiedForInstall) throw new Error("Application update is not verified for installation");
      const id = ready.id;
      verifiedForInstall = false;
      await apply(id);
    },
    start() { void check(); },
    stop() { stopped = true; revoke(); abort.abort(); },
  };
}
