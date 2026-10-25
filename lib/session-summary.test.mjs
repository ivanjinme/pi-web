import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { discoverSessionFiles, readSessionHeader, readSessionTitle, readSessionTitles } = await jiti.import("./session-summary.ts");
const user = (content) => ({ type: "message", message: { role: "user", content } });
const info = (name) => ({ type: "session_info", name });

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-web-summary-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, "project");
  await mkdir(dir);
  return { root, dir };
}

async function sessionFile(dir, id, entries, tail = "") {
  const path = join(dir, `${id}.jsonl`);
  const header = { type: "session", version: 3, id, cwd: dir, timestamp: "2026-01-01T00:00:00Z" };
  await writeFile(path, [header, ...entries].map(JSON.stringify).join("\r\n") + "\r\n" + tail);
  return path;
}

test("reverse title lookup matches SDK across rename, clear, fallback and empty sessions", async (t) => {
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
  const { dir } = await fixture(t);
  const cases = [
    [],
    [user("中文消息".repeat(30))],
    [user([{ type: "image", data: "abc" }]), user([{ type: "text", text: "first" }, { type: "text", text: "message" }])],
    [user("fallback"), info("old"), info(" latest ")],
    [user("fallback"), info("old"), info("")],
    [user('literal {"type":"session_info","name":"not a title"}')],
    [info("early title"), { type: "message", message: { role: "toolResult", content: [{ type: "text", text: "x".repeat(160_000) }] } }],
    [user("fallback"), { type: "message", message: { role: "toolResult", content: [], details: { type: "session_info", name: "nested, not a title" } } }],
  ];
  for (const [index, entries] of cases.entries()) await sessionFile(dir, `s${index}`, entries, '{"type":"session_info","name":');
  for (const session of await SessionManager.list(dir, dir)) {
    const actual = await readSessionTitle(session.path);
    assert.equal(actual.name || actual.firstMessage, session.name || session.firstMessage.slice(0, 50));
  }
});

test("title batches return names or short fallbacks without full original prompts", async (t) => {
  const { dir } = await fixture(t);
  const prompt = "original-prompt " + "x".repeat(60) + " beyond-fifty";
  const files = [];
  for (const named of [true, false]) {
    const id = named ? "named" : "unnamed";
    files.push({ id, path: await sessionFile(dir, id, [user(prompt), ...(named ? [info("Manual title")] : []), user("later prompt")]) });
  }
  const visible = await readSessionTitles(files);
  assert.equal(visible[0].firstMessage, "");
  assert.equal(visible[1].firstMessage, prompt.slice(0, 50));
  assert.equal(visible[0].name, "Manual title");
  assert.ok(visible.every((session) => !session.firstMessage.includes("beyond-fifty")));
});

test("reverse byte search handles every token split and UTF-8 titles", async (t) => {
  const { dir } = await fixture(t);
  const path = join(dir, "boundary.jsonl");
  const token = Buffer.from('"session_info"');
  const content = Buffer.from([user("fallback"), info("跨块中文标题")].map(JSON.stringify).join("\n") + "\n");
  const position = content.indexOf(token);
  for (let split = 1; split < token.length; split++) {
    await writeFile(path, Buffer.concat([content, Buffer.alloc(1024 * 1024 + split - (content.length - position), 32)]));
    assert.deepEqual(await readSessionTitle(path), { name: "跨块中文标题", firstMessage: "" });
  }
});

test("header discovery ignores malformed bodies and sorts by file modification time", async (t) => {
  const { root, dir } = await fixture(t);
  const older = await sessionFile(dir, "older", [], "malformed body\n" + "x".repeat(200_000));
  const newer = await sessionFile(dir, "newer", [info("title")]);
  await utimes(older, new Date("2026-01-01"), new Date("2026-01-01"));
  await utimes(newer, new Date("2026-02-01"), new Date("2026-02-01"));
  await writeFile(join(dir, "broken.jsonl"), "not a header\n");
  const sessions = await discoverSessionFiles(root);
  assert.deepEqual(sessions.map((s) => s.header.id), ["newer", "older"]);
  assert.equal(readSessionHeader(older).id, "older");
  assert.deepEqual(await discoverSessionFiles(join(root, "missing")), []);
});
