import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const moduleUrl = new URL("./navigation.mjs", import.meta.url).href;

function launch(profile, env) {
  const script = `
    import { restoreDesktopPort, SERVER_URL, isAppUrl } from ${JSON.stringify(moduleUrl)};
    restoreDesktopPort(${JSON.stringify(profile)}, ${JSON.stringify(env)});
    process.stdout.write(JSON.stringify({ origin: SERVER_URL, trusted: isAppUrl(SERVER_URL + '/api/sessions'), devTrusted: isAppUrl('http://127.0.0.1:8888') }));
  `;
  return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
}

async function profile(t) {
  const root = await mkdtemp(join(tmpdir(), "weclio-port-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("a fresh process restores the packaged port without launcher environment", async (t) => {
  const root = await profile(t);
  assert.deepEqual(launch(root, { WECLIO_DESKTOP_URL: "http://127.0.0.1:8890", PORT: "8888" }), { origin: "http://127.0.0.1:8890", trusted: true, devTrusted: false });
  assert.deepEqual(JSON.parse(await readFile(join(root, "desktop-port.json"), "utf8")), { port: 8890 });
  assert.deepEqual(launch(root, {}), { origin: "http://127.0.0.1:8890", trusted: true, devTrusted: false });
});

test("explicit launcher settings override and replace the remembered port", async (t) => {
  const root = await profile(t);
  launch(root, { PORT: "8890" });
  assert.equal(launch(root, { PORT: "8891" }).origin, "http://127.0.0.1:8891");
  assert.equal(launch(root, {}).origin, "http://127.0.0.1:8891");
  assert.equal(launch(root, { WECLIO_DESKTOP_URL: "http://127.0.0.1:80" }).origin, "http://127.0.0.1");
  assert.equal(launch(root, {}).origin, "http://127.0.0.1");
});

test("the default port does not create configuration without an explicit setting", async (t) => {
  const root = await profile(t);
  assert.equal(launch(root, {}).origin, "http://127.0.0.1:8888");
  await assert.rejects(readFile(join(root, "desktop-port.json")), { code: "ENOENT" });
});

test("invalid launcher origins do not overwrite the saved port", async (t) => {
  const root = await profile(t);
  launch(root, { PORT: "8890" });
  for (const address of ["http://example.com:8890", "http://127.0.0.1:8890/path", "http://user:pass@127.0.0.1:8890", "http://127.0.0.1:0"]) {
    assert.throws(() => launch(root, { WECLIO_DESKTOP_URL: address }));
  }
  assert.equal(launch(root, {}).origin, "http://127.0.0.1:8890");
});

test("corrupt saved configuration fails rather than returning to the development port", async (t) => {
  const root = await profile(t);
  for (const value of ["invalid JSON", "null", "{}", '{"port":0}', '{"port":65536}', '{"port":"8890"}']) {
    await writeFile(join(root, "desktop-port.json"), value);
    assert.throws(() => launch(root, {}));
    assert.equal(await readFile(join(root, "desktop-port.json"), "utf8"), value);
  }
});
