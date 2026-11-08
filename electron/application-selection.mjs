import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { compareVersions, isStableVersion } from "./application-manifest.mjs";

const POINTER_LIMIT = 4096;
const validId = (id) => typeof id === "string" && /^[a-f0-9]{64}$/.test(id);
const emptyState = () => ({ schema: 1, active: null, previous: null, pending: false, attempted: false, failed: null });
const missing = (error) => error.code === "ENOENT";
const incompatible = (error) => error.code === "ERR_APPLICATION_INCOMPATIBLE"
  || error.message === "Invalid prepared application: incompatible shell or toolset";

function checkedState(value) {
  const keys = ["schema", "active", "previous", "pending", "attempted", "failed"];
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))
    || value.schema !== 1 || [value.active, value.previous, value.failed].some((id) => id !== null && !validId(id))
    || typeof value.pending !== "boolean" || typeof value.attempted !== "boolean"
    || (value.pending && value.active === null) || (value.attempted && !value.pending)
    || (value.active !== null && value.previous === value.active)) {
    throw new Error("Invalid application selection pointer");
  }
  return value;
}

async function realLocation(location) {
  const absolute = path.resolve(location);
  try {
    return await realpath(absolute);
  } catch (error) {
    if (!missing(error) || path.dirname(absolute) === absolute) throw error;
    return path.join(await realLocation(path.dirname(absolute)), path.basename(absolute));
  }
}

function inside(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export async function resolveApplicationStore({ resourcesPath, localAppData }) {
  if (typeof resourcesPath !== "string" || !path.isAbsolute(resourcesPath)) throw new Error("An absolute resourcesPath is required");
  if (typeof localAppData !== "string" || !path.isAbsolute(localAppData)) {
    throw new Error("An absolute localAppData is required for application storage; configure a writable per-user data directory");
  }
  const installation = path.dirname(await realLocation(resourcesPath));
  let base;
  try {
    base = await realLocation(localAppData);
    try {
      if (!(await lstat(base)).isDirectory()) throw new Error("Not a directory");
    } catch (error) {
      if (!missing(error)) throw error;
    }
  } catch (error) {
    throw new Error("Invalid localAppData; configure an accessible per-user data directory", { cause: error });
  }
  for (const candidate of [path.join(base, "Weclio", "applications"), path.join(base, "Weclio-applications")]) {
    const canonical = await realLocation(candidate);
    if (!inside(canonical, installation)) return canonical;
  }
  throw new Error("Application storage overlaps the installation. Reinstall Weclio in a dedicated installation directory, not directly in localAppData");
}

async function defaultReadPrepared(options) {
  const { readPreparedApplication } = await import("./application-store.mjs");
  return readPreparedApplication(options);
}

export function createApplicationSelection({ storeRoot, selectionRoot = storeRoot, bundledRoot, bundledVersion, key, shell, devFixture = false, readPrepared = defaultReadPrepared }) {
  if (typeof storeRoot !== "string" || !path.isAbsolute(storeRoot)
    || typeof selectionRoot !== "string" || !path.isAbsolute(selectionRoot)
    || typeof bundledRoot !== "string" || !path.isAbsolute(bundledRoot)
    || !isStableVersion(bundledVersion) || typeof readPrepared !== "function") {
    throw new Error("Application selection requires absolute store/selection/bundled roots and a stable bundled version");
  }
  const store = path.resolve(storeRoot);
  const root = path.resolve(selectionRoot);
  const pointer = path.join(root, "current.json");
  const bundled = { id: null, version: bundledVersion, serverRoot: bundledRoot };
  let state;
  let current;
  let queue = Promise.resolve();
  const serialize = (operation) => {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  };
  const result = () => current && { ...current, ...(state.failed === null ? {} : { failed: state.failed }) };

  async function checkedRoot() {
    if (path.relative(root, await realLocation(root)) !== "") throw new Error("Application selectionRoot must be canonical, not a linked path");
    await mkdir(root, { recursive: true });
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink() || path.relative(root, await realpath(root)) !== "") {
      throw new Error("Application selectionRoot must be a canonical directory, not a linked path");
    }
  }

  async function readState() {
    await checkedRoot();
    let info;
    try {
      info = await lstat(pointer);
    } catch (error) {
      if (missing(error)) return emptyState();
      throw error;
    }
    if (!info.isFile() || info.isSymbolicLink() || info.size > POINTER_LIMIT) throw new Error("Invalid application selection pointer file");
    const handle = await open(pointer, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size > POINTER_LIMIT || opened.dev !== info.dev || opened.ino !== info.ino) throw new Error("Application selection pointer changed while reading");
      const buffer = Buffer.alloc(POINTER_LIMIT + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > POINTER_LIMIT) throw new Error("Application selection pointer is too large");
      return checkedState(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead))));
    } finally {
      await handle.close();
    }
  }

  async function writeState(next) {
    checkedState(next);
    await checkedRoot();
    const temporary = path.join(root, `.current-${randomUUID()}.tmp`);
    let created = false;
    try {
      const handle = await open(temporary, "wx", 0o600);
      created = true;
      try {
        await handle.writeFile(`${JSON.stringify(next)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await checkedRoot();
      await rename(temporary, pointer);
      created = false;
    } finally {
      if (created) await unlink(temporary);
    }
  }

  async function resolve(id) {
    if (id === null) return { ...bundled };
    if (!validId(id)) throw new Error("Invalid application selection id");
    // 已准备程序的路径、版本和兼容性只能来自存储层验证结果。
    const prepared = await readPrepared({ storeRoot: store, id, key, shell, devFixture });
    return { id: prepared.id, version: prepared.version, serverRoot: prepared.serverRoot };
  }

  async function select(next, selected) {
    await writeState(next);
    state = next;
    current = selected;
    return result();
  }

  async function restore(previous, failed) {
    let selected;
    try {
      selected = await resolve(previous);
    } catch (error) {
      if (!missing(error) && !incompatible(error)) throw error;
      selected = { ...bundled };
    }
    return select({ ...emptyState(), active: selected.id, failed }, selected);
  }

  async function begin() {
    if (current) {
      if (state.pending && !state.attempted) return select({ ...state, attempted: true }, current);
      return result();
    }
    const saved = await readState();
    // 健康确认前的第二次启动必须先回退，不能再次执行失败候选。
    if (saved.pending && saved.attempted) return restore(saved.previous, saved.active);
    let selected;
    try {
      selected = await resolve(saved.active);
    } catch (error) {
      if (!incompatible(error)) throw error;
      return select({ ...emptyState(), failed: saved.active ?? saved.failed }, { ...bundled });
    }
    if (saved.pending) return select({ ...saved, attempted: true }, selected);
    state = saved;
    current = selected;
    return result();
  }

  return {
    begin: () => serialize(begin),
    commit: (id) => serialize(async () => {
      if (!current) await begin();
      if (state.pending) throw new Error("An application health acknowledgement is still pending");
      if (!validId(id)) throw new Error("Invalid application selection id");
      if (id === state.failed) throw new Error("Cannot retry the failed application selection");
      const selected = await resolve(id);
      if (compareVersions(selected.version, current.version) <= 0) throw new Error("Application selection must be a newer version");
      return select({ schema: 1, active: id, previous: current.id, pending: true, attempted: false, failed: state.failed }, selected);
    }),
    healthy: () => serialize(async () => {
      if (!current) await begin();
      // commit 只持久化下次启动选择；未启动的候选不可提前确认健康。
      if (state.pending && state.attempted) return select({ ...state, pending: false, attempted: false }, current);
      return result();
    }),
    rollback: () => serialize(async () => {
      if (!current) await begin();
      if (current.id === null) return result();
      return restore(state.previous, current.id);
    }),
    getCurrent: result,
    needsHealthAcknowledgement: () => Boolean(state?.pending && state.attempted),
  };
}
