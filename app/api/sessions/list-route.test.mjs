import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

let requested = [];
const jiti = createJiti(import.meta.url, {
  virtualModules: {
    "@/lib/session-reader": {
      listAllSessions: async () => [{ id: "thread", titleLoaded: false }],
      loadSessionTitles: async (...args) => { requested = args; return [{ id: "thread", name: "Title", firstMessage: "" }]; },
    },
    "@/lib/rpc-manager": { getRunningRpcSessionIds: () => [] },
  },
});
const { GET, POST } = await jiti.import("./route.ts");
const request = (body) => new Request("http://localhost/api/sessions", { method: "POST", body: JSON.stringify(body) });

test("GET returns only the lightweight catalog", async () => {
  const response = await GET();
  assert.deepEqual(await response.json(), { sessions: [{ id: "thread", titleLoaded: false }], runningSessionIds: [] });
});

test("POST loads explicit title IDs", async () => {
  const response = await POST(request({ ids: ["thread"] }));
  assert.equal(response.status, 200);
  assert.deepEqual(requested, [["thread"]]);
  assert.deepEqual(await response.json(), { titles: [{ id: "thread", name: "Title", firstMessage: "" }] });
});

test("POST rejects malformed, non-string and oversized batches", async () => {
  for (const body of [null, {}, { ids: "thread" }, { ids: [42] }, { ids: Array(101).fill("id") }]) {
    assert.equal((await POST(request(body))).status, 400);
  }
  assert.equal((await POST(new Request("http://localhost", { method: "POST", body: "{" }))).status, 400);
});
