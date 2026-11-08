import { createHash, createPublicKey, sign, verify } from "node:crypto";
import { APPLICATION_MANIFEST_NAME, LIMITS, compareVersions, isStableVersion } from "./application-manifest.mjs";
import { updateUrl } from "./update-signature.mjs";

export const INDEX_NAME = "desktop-release-index.json";
export const INDEX_PROTOCOL = 1;
const UPDATE_MANIFEST = "desktop-update-manifest.json";
const GITHUB_LATEST = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/releases\/latest\/download\/desktop-update-manifest\.json$/;
const TAG = /^desktop-v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const HEX = /^[a-f0-9]{64}$/;

const invalid = (message) => { throw new Error(`Invalid release index: ${message}`); };

function exact(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) invalid("fields");
}

function canonicalBase64(value, size, maximum) {
  if (typeof value !== "string" || !value || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) || (maximum && value.length > 4 * Math.ceil(maximum / 3))) invalid("base64");
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value || (size !== undefined && bytes.length !== size) || (maximum !== undefined && bytes.length > maximum)) invalid("base64 length");
  return bytes;
}

function checkedShell(value, withSchema) {
  exact(value, withSchema ? ["schema", "version", "digest", "toolset"] : ["version", "digest", "toolset"]);
  if ((withSchema && value.schema !== 1) || !isStableVersion(value.version) || !HEX.test(value.digest) || !HEX.test(value.toolset)) invalid("shell");
  return { version: value.version, digest: value.digest, toolset: value.toolset };
}

function checkedUrl(value, filename, devFixture) {
  const url = updateUrl(value, devFixture);
  if (url.protocol === "http:" && url.hostname !== "127.0.0.1") invalid("URL");
  if (!url.pathname.endsWith(`/${filename}`)) invalid("URL filename");
  return url.href;
}

function section(value, filename, devFixture, buildUrl) {
  if (value === null) return null;
  exact(value, ["version", "manifestUrl"]);
  if (!isStableVersion(value.version)) invalid("section version");
  return { version: value.version, manifestUrl: checkedUrl(value.manifestUrl, filename, devFixture), ...(buildUrl ? {} : {}) };
}

function versions(body) {
  const sections = [body.installer?.version, body.application?.version].filter(Boolean);
  if (!sections.length) invalid("missing sections");
  const highest = sections.reduce((left, right) => compareVersions(left, right) >= 0 ? left : right);
  if (body.version !== highest || compareVersions(body.version, body.shell.version) < 0) invalid("version ordering");
}

export function buildReleaseIndex({ version, shell, installer, application, releaseBase, signing, devFixture = false }) {
  const trimmed = checkedShell(shell, true);
  if (!isStableVersion(version)) invalid("version");
  const match = GITHUB_LATEST.exec(signing?.config?.manifestUrl ?? "");
  if (!match || [match[1], match[2]].some((part) => part === "." || part === "..")) invalid("signing manifest URL");
  const base = `https://github.com/${match[1]}/${match[2]}/releases/download/`;
  if (releaseBase !== undefined && releaseBase !== base) invalid("release base");
  const installerSection = installer === null ? null : (() => {
    const keys = installer?.tag === undefined ? ["version"] : ["version", "tag"];
    exact(installer, keys);
    if (!isStableVersion(installer.version) || (installer.tag !== undefined && !TAG.test(installer.tag))) invalid("installer");
    return { version: installer.version, manifestUrl: `${base}${installer.tag ?? `desktop-v${installer.version}`}/${UPDATE_MANIFEST}` };
  })();
  const applicationSection = application === null ? null : (() => {
    exact(application, ["version"]);
    if (!isStableVersion(application.version)) invalid("application");
    return { version: application.version, manifestUrl: `${base}desktop-v${application.version}/${APPLICATION_MANIFEST_NAME}` };
  })();
  const body = { schema: INDEX_PROTOCOL, type: "weclio-release-index", version, shell: trimmed, installer: installerSection, application: applicationSection };
  versions(body);
  const publicKey = createPublicKey(signing.config.publicKey);
  if (signing.privateKey?.asymmetricKeyType !== "ed25519"
    || publicKey.asymmetricKeyType !== "ed25519"
    || publicKey.export({ type: "spki", format: "pem" }).toString() !== signing.config.publicKey) invalid("signing key");
  const payload = Buffer.from(JSON.stringify(body));
  const envelope = { payload: payload.toString("base64"), signature: sign(null, payload, signing.privateKey).toString("base64") };
  verifyReleaseIndex(envelope, publicKey, devFixture);
  return envelope;
}

export function verifyReleaseIndex(envelope, key, devFixture = false) {
  exact(envelope, ["payload", "signature"]);
  const payload = canonicalBase64(envelope.payload, undefined, LIMITS.manifestBytes);
  const signature = canonicalBase64(envelope.signature, 64);
  const publicKey = key?.type === "public" ? key : createPublicKey(key);
  if (publicKey.asymmetricKeyType !== "ed25519" || !verify(null, payload, publicKey, signature)) invalid("signature");
  // 验签之后才解析：未签名内容不参与任何字段或 URL 判断。
  const body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload));
  exact(body, ["schema", "type", "version", "shell", "installer", "application"]);
  if (body.schema !== INDEX_PROTOCOL || body.type !== "weclio-release-index" || !isStableVersion(body.version)) invalid("body");
  const shell = checkedShell(body.shell, false);
  const installer = section(body.installer, UPDATE_MANIFEST, devFixture);
  const application = section(body.application, APPLICATION_MANIFEST_NAME, devFixture);
  const normalized = { schema: INDEX_PROTOCOL, type: "weclio-release-index", version: body.version, shell, installer, application };
  versions(normalized);
  return { ...normalized, id: createHash("sha256").update(payload).digest("hex") };
}

export function releaseKind(index) {
  if (!index) return "none";
  if (index.installer && index.application) return "both";
  if (index.installer) return "shell";
  if (index.application) return "application";
  return "none";
}

export function releaseIndexUrl(legacyManifestUrl, devFixture = false) {
  try {
    const url = updateUrl(legacyManifestUrl, devFixture);
    if (url.protocol === "http:" && url.hostname !== "127.0.0.1") return null;
    if (!url.pathname.endsWith(`/${UPDATE_MANIFEST}`)) return null;
    url.pathname = url.pathname.slice(0, -UPDATE_MANIFEST.length) + INDEX_NAME;
    return url;
  } catch {
    return null;
  }
}