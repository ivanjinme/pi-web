import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8");

test("manual compaction reloads live context usage after the command completes", () => {
  const compact = source.slice(
    source.indexOf('case "compact": {'),
    source.indexOf('case "reload": {'),
  );

  assert.match(compact, /await sendAgentCommand\(sid,\s*\{\s*type: "compact"/);
  assert.match(compact, /await loadSession\(sid, true, true\)/);
});

test("successful compaction events refresh live state as well as messages", () => {
  const compactEnd = source.slice(
    source.indexOf('case "compaction_end":'),
    source.indexOf('case "extension_ui_request":'),
  );

  assert.match(compactEnd, /else if \(!event\.aborted\)/);
  assert.match(compactEnd, /loadSession\(sessionIdRef\.current, false, true\)/);
});

test("session state reload accepts unknown post-compaction usage instead of retaining the old percentage", () => {
  const loadSession = source.slice(
    source.indexOf("const loadSession = useCallback"),
    source.indexOf("const loadContext = useCallback"),
  );

  assert.match(loadSession, /if \(!includeState\) return null/);
  assert.match(loadSession, /if \(sessionIdRef\.current !== sid\) return null/);
  assert.match(loadSession, /if \(liveState\.contextUsage !== undefined\) setContextUsage\(liveState\.contextUsage \?\? null\)/);
});
