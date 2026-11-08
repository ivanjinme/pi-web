import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { compareVersions, isStableVersion } from "./application-manifest.mjs";

export const BASELINE_PATH = "electron/desktop-shell-baseline.json";
export const BASELINE_SCHEMA = 1;

const HEX256 = /^[0-9a-f]{64}$/;
const FIELDS = ["schema", "version", "digest", "toolset"];

function assertShell(shell, subject) {
  if (!shell || typeof shell !== "object" || Array.isArray(shell) || Object.keys(shell).length !== FIELDS.length || FIELDS.some((field) => !Object.hasOwn(shell, field))) {
    throw new Error(`Invalid ${subject}: expected exactly the fields ${FIELDS.join(", ")}`);
  }
  if (shell.schema !== BASELINE_SCHEMA) throw new Error(`Invalid ${subject}: schema must be ${BASELINE_SCHEMA}`);
  if (!isStableVersion(shell.version)) throw new Error(`Invalid ${subject}: version must be a stable major.minor.patch version`);
  if (typeof shell.digest !== "string" || !HEX256.test(shell.digest)) throw new Error(`Invalid ${subject}: digest must be a lowercase SHA-256 hex string`);
  if (typeof shell.toolset !== "string" || !HEX256.test(shell.toolset)) throw new Error(`Invalid ${subject}: toolset must be a lowercase SHA-256 hex string`);
  return { schema: BASELINE_SCHEMA, version: shell.version, digest: shell.digest, toolset: shell.toolset };
}

// 基线记录"上一次已发布的壳"；缺失即首版，损坏必须显式报错而不是当作缺失。
export async function readShellBaseline({ root, path = join(root, BASELINE_PATH) }) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error(`Cannot read desktop shell baseline ${path}: ${error.message}`);
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`Invalid desktop shell baseline ${path}: not valid JSON`);
  }
  return assertShell(body, `desktop shell baseline ${path}`);
}

export function decideReleaseKind({ currentShell, baseline }) {
  const current = assertShell(currentShell, "current desktop shell descriptor");
  if (baseline === null || baseline === undefined) {
    return { kind: "shell", sameDigest: false, reason: `no published shell baseline; ${current.version} is the first shell release` };
  }
  const published = assertShell(baseline, "desktop shell baseline");
  const sameDigest = current.digest === published.digest;
  if (!sameDigest || current.toolset !== published.toolset) {
    return { kind: "shell", sameDigest, reason: `shell content changed since ${published.version} (digest ${published.digest} -> ${current.digest}, toolset ${published.toolset} -> ${current.toolset})` };
  }
  if (compareVersions(current.version, published.version) > 0) {
    return { kind: "application", sameDigest, reason: `shell ${current.digest} is unchanged since ${published.version}; ${current.version} changes application files only` };
  }
  throw new Error(`No release change: shell ${current.digest} is already published as ${published.version}, and ${current.version} is not newer`);
}

export async function writeShellBaseline({ root, shell, path = join(root, BASELINE_PATH) }) {
  const next = assertShell(shell, "current desktop shell descriptor");
  const published = await readShellBaseline({ root, path });
  if (published) {
    const order = compareVersions(next.version, published.version);
    if (order < 0) throw new Error(`Refusing to move the desktop shell baseline backwards: ${next.version} < ${published.version}`);
    // 同一版本号已发布过不同壳内容时不允许改写，否则已发布清单与基线会互相矛盾。
    if (order === 0 && (next.digest !== published.digest || next.toolset !== published.toolset)) {
      throw new Error(`Refusing to rewrite the published desktop shell baseline for ${published.version} with a different digest or toolset; bump the version first`);
    }
  }
  const body = JSON.stringify({ schema: BASELINE_SCHEMA, version: next.version, digest: next.digest, toolset: next.toolset }) + "\n";
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, body, { flag: "wx" });
    // 同目录 rename 保证读者只会看到旧基线或完整新基线。
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  return next;
}