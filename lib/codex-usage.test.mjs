import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { parseCodexUsage, createCodexUsageReader } = await jiti.import("./codex-usage.ts");
const payload = {
  rate_limit: {
    primary_window: { used_percent: 23.5, reset_at: 1800000000 },
    secondary_window: { used_percent: 100, reset_at: 1800500000 },
  },
  secret: "must not reach browser",
};
const token = (account) => `header.${Buffer.from(JSON.stringify({
  "https://api.openai.com/auth": { chatgpt_account_id: account },
})).toString("base64url")}.signature`;
const auth = (account = "account-a") => ({ auth: { apiKey: token(account) }, source: "OAuth" });

test("maps primary and secondary, subtracts used percentage, and strips upstream data", () => {
  assert.deepEqual(parseCodexUsage(payload), {
    status: "available",
    primary: { remainingPercent: 76.5, resetAt: new Date(1800000000000).toISOString() },
    secondary: { remainingPercent: 0, resetAt: new Date(1800500000000).toISOString() },
  });
  assert.equal(parseCodexUsage({ rate_limit: { primary_window: { used_percent: 0 } } }).primary.remainingPercent, 100);
});

test("missing or invalid windows degrade independently without throwing", () => {
  for (const input of [null, {}, [], { rate_limit: { primary_window: { used_percent: "4" } } },
    { rate_limit: { primary_window: { used_percent: 101 } } }]) {
    assert.deepEqual(parseCodexUsage(input), { status: "unavailable" });
  }
  assert.deepEqual(parseCodexUsage({ rate_limit: { secondary_window: { used_percent: 2, reset_at: 1e100 } } }), {
    status: "available", primary: null, secondary: { remainingPercent: 98, resetAt: null },
  });
});

test("uses OAuth on the server, deduplicates requests, and caches for exactly 120 seconds", async () => {
  let now = 0;
  let calls = 0;
  const reader = createCodexUsageReader({
    now: () => now,
    resolveAuth: async () => auth(),
    fetch: async (url, options) => {
      calls++;
      assert.equal(url, "https://chatgpt.com/backend-api/wham/usage");
      assert.equal(options.headers.Authorization, `Bearer ${token("account-a")}`);
      assert.equal(options.headers["ChatGPT-Account-Id"], "account-a");
      assert.equal(options.redirect, "error");
      assert.equal(options.cache, "no-store");
      await new Promise((resolve) => setTimeout(resolve, 10));
      return Response.json(payload);
    },
  });
  const results = await Promise.all([reader(), reader(), reader()]);
  assert.equal(calls, 1);
  assert.ok(results.every((data) => data.status === "available"));
  assert.doesNotMatch(JSON.stringify(results), /signature|account-a|secret/);
  now = 119999;
  await reader();
  assert.equal(calls, 1);
  now = 120000;
  await reader();
  assert.equal(calls, 2);
});

test("does not reuse cached usage after logout or account changes", async () => {
  let current = auth();
  let calls = 0;
  const reader = createCodexUsageReader({
    resolveAuth: async () => current,
    fetch: async () => { calls++; return Response.json(payload); },
  });
  await reader();
  current = undefined;
  assert.deepEqual(await reader(), { status: "unavailable" });
  current = auth("account-b");
  await reader();
  assert.equal(calls, 2);
});

test("auth errors, malformed tokens, HTTP errors, invalid JSON, and network failures are isolated", async () => {
  const cases = [
    { resolveAuth: async () => { throw new Error("private auth failure"); } },
    { resolveAuth: async () => undefined },
    { resolveAuth: async () => ({ auth: { apiKey: "invalid" } }) },
    { fetch: async () => new Response("private failure", { status: 401 }) },
    { fetch: async () => new Response("not json") },
    { fetch: async () => { throw new Error("private network failure"); } },
  ];
  for (const overrides of cases) {
    const reader = createCodexUsageReader({ resolveAuth: async () => auth(), ...overrides });
    assert.deepEqual(await reader(), { status: "unavailable" });
  }
});

test("timeout bounds both authentication and response body reading", async () => {
  let signal;
  const reader = createCodexUsageReader({
    timeoutMs: 20,
    resolveAuth: async (input) => { signal = input; return new Promise(() => {}); },
  });
  assert.deepEqual(await reader(), { status: "unavailable" });
  assert.equal(signal.aborted, true);
  const bodyReader = createCodexUsageReader({
    timeoutMs: 20,
    resolveAuth: async () => auth(),
    fetch: async (_url, options) => {
      signal = options.signal;
      return { ok: true, json: () => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }) };
    },
  });
  assert.deepEqual(await bodyReader(), { status: "unavailable" });
  assert.equal(signal.aborted, true);
});
