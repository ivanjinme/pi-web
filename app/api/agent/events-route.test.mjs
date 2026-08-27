import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./[id]/events/route.ts", import.meta.url), "utf8");

test("SSE subscribes before publishing the Pi 0.84 streaming snapshot", () => {
  const start = source.slice(source.indexOf("const snapshotState"), source.indexOf("// Heartbeat"));
  assert.match(start, /isStreaming: session\.isStreaming/);
  assert.match(start, /type: "message_start", message: snapshotState\.message/);
  assert.ok(start.indexOf("session.onEvent") < start.indexOf("snapshotState.message = session.streamingMessage"));
  assert.ok(start.indexOf('type: "connected"') < start.indexOf('type: "message_start"'));
  assert.match(start, /if \(!snapshotState\.published\)/);
  assert.match(start, /isEventIncludedInSnapshot\(event, snapshotState\.message\)/);
});

test("SSE projects SDK events before sending them", () => {
  assert.match(source, /toClientAgentEvent\(event\)/);
  assert.match(source, /if \(clientEvent\) encode\(clientEvent\)/);
});
