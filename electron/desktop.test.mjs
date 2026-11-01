import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import { test } from "node:test";
import { SERVER_URL, isAppUrl, isExternalUrl, isPermissionAllowed } from "./navigation.mjs";
import { assertPortAvailable, waitForServer } from "./server.mjs";

async function serve(t, handler) {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  return { port: server.address().port, url: `http://127.0.0.1:${server.address().port}` };
}

test("desktop defaults to the shared web port and accepts a launcher-provided origin", () => {
  const moduleUrl = new URL("./navigation.mjs", import.meta.url).href;
  const script = `import { SERVER_URL } from ${JSON.stringify(moduleUrl)}; process.stdout.write(SERVER_URL);`;
  const env = { ...process.env };
  delete env.WECLIO_DESKTOP_URL;
  assert.equal(execFileSync(process.execPath, ["--input-type=module", "-e", script], { env, encoding: "utf8" }), "http://127.0.0.1:8888");
  env.WECLIO_DESKTOP_URL = "http://127.0.0.1:49152";
  assert.equal(execFileSync(process.execPath, ["--input-type=module", "-e", script], { env, encoding: "utf8" }), env.WECLIO_DESKTOP_URL);
});

test("only the exact application origin may navigate inside the desktop", () => {
  assert.equal(isAppUrl(`${SERVER_URL}/?session=123`), true);
  for (const url of ["https://example.com", "http://127.0.0.1:8889", "http://127.0.0.1:9999", "http://localhost:8888", "http://127.0.0.1:8888.evil.com", "file:///C:/secret", "javascript:alert(1)", "invalid"]) {
    assert.equal(isAppUrl(url), false, url);
  }
});

test("only external HTTP(S) links may open outside the desktop", () => {
  assert.equal(isExternalUrl("https://example.com/docs"), true);
  assert.equal(isExternalUrl("http://example.com/docs"), true);
  for (const url of [SERVER_URL, "file:///C:/secret", "mailto:test@example.com", "vscode://file/test", "javascript:alert(1)", "data:text/html,test", "invalid"]) {
    assert.equal(isExternalUrl(url), false, url);
  }
});

test("clipboard writes are allowed only for the application origin", () => {
  for (const url of [SERVER_URL, `${SERVER_URL}/?session=123`]) {
    assert.equal(isPermissionAllowed("clipboard-sanitized-write", url), true, url);
  }
  for (const url of ["https://example.com", "http://127.0.0.1:8889", "http://localhost:8888", "file:///C:/secret", "data:text/html,test", "invalid", "", undefined]) {
    assert.equal(isPermissionAllowed("clipboard-sanitized-write", url), false, String(url));
  }
});

test("clipboard reads and other permissions remain denied for the application", () => {
  for (const permission of ["clipboard-read", "deprecated-sync-clipboard-read", "media", "geolocation", "notifications", "openExternal", "unknown"]) {
    assert.equal(isPermissionAllowed(permission, SERVER_URL), false, permission);
  }
});

test("an occupied port is rejected without stopping or changing its server", async (t) => {
  const { port, url } = await serve(t, (_request, response) => response.end("existing"));
  await assert.rejects(assertPortAvailable(port), /已被占用/);
  assert.equal(await (await fetch(url)).text(), "existing");
});

test("port probe releases its listener", async () => {
  await assertPortAvailable(0);
});

test("readiness requires both the owned process readiness and an HTTP 200", async (t) => {
  let requests = 0;
  let ready = false;
  const { url } = await serve(t, (_request, response) => {
    requests++;
    response.writeHead(requests === 1 ? 503 : 200).end();
  });
  const controller = new AbortController();
  const waiting = waitForServer(url, { signal: controller.signal, isReady: () => ready, timeout: 3000 });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(requests, 0, "must not probe another process before the owned server is ready");
  ready = true;
  await waiting;
  assert.equal(requests, 2);
});

test("startup has a bounded timeout", async () => {
  await assert.rejects(waitForServer("http://127.0.0.1:1", {
    signal: new AbortController().signal,
    isReady: () => true,
    timeout: 50,
  }), /未就绪/);
});

test("shutdown aborts startup polling", async () => {
  const controller = new AbortController();
  const waiting = waitForServer("http://127.0.0.1:1", {
    signal: controller.signal,
    isReady: () => false,
  });
  controller.abort();
  await assert.rejects(waiting, { name: "AbortError" });
});

test("shutdown aborts an in-flight HTTP readiness request", async (t) => {
  const controller = new AbortController();
  const { url } = await serve(t, () => controller.abort());
  await assert.rejects(waitForServer(url, {
    signal: controller.signal,
    isReady: () => true,
  }), { name: "AbortError" });
});
