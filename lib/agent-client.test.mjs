import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { sendAgentCommand } = await jiti.import("./agent-client.ts");

test("agent client preserves the command payload, encoded session id and result envelope", async (t) => {
  const command = { type: "fork", entryId: "entry", includeEntry: true };
  const result = { cancelled: false, newSessionId: "child" };
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "/api/agent/session%2Fid");
    assert.equal(options.method, "POST");
    assert.equal(options.headers["Content-Type"], "application/json");
    assert.deepEqual(JSON.parse(options.body), command);
    return Response.json({ success: true, data: result });
  });
  assert.deepEqual(await sendAgentCommand("session/id", command), result);
});

test("agent client preserves null command results", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ success: true, data: null }));
  assert.equal(await sendAgentCommand("session", { type: "abort" }), null);
});

test("agent client surfaces server errors even in a successful HTTP response", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ error: "Cannot fork while busy" }));
  await assert.rejects(sendAgentCommand("session", { type: "fork", entryId: "entry" }), /Cannot fork while busy/);
});

test("agent client uses HTTP status when the error response is not JSON", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("Unavailable", { status: 503 }));
  await assert.rejects(sendAgentCommand("session", { type: "get_state" }), /HTTP 503/);
});
