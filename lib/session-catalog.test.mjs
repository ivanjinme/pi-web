import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

let files = [];
let discoveries = 0;
let titleReads = [];
let discovery = async () => files;
const jiti = createJiti(import.meta.url, {
  virtualModules: {
    "./session-summary": {
      discoverSessionFiles: async () => { discoveries++; return discovery(); },
      readSessionTitles: async (sessions) => {
        titleReads.push(...sessions.map((session) => session.id));
        return sessions.map((session) => ({ id: session.id, name: "title", firstMessage: "" }));
      },
    },
    "./worktree": {
      resolveProject: async (cwd) => ({ projectRoot: cwd.endsWith("worktree") ? "/main" : cwd }),
    },
  },
});
const { listAllSessions, loadSessionTitles, resolveSessionPath, invalidateSessionListCache, subscribeSessionListChanges } = await jiti.import("./session-reader.ts");

function reset() {
  discoveries = 0;
  titleReads = [];
  files = [
    { path: "/sessions/new.jsonl", modified: "2026-02-01", header: { id: "new", cwd: "/main-worktree", timestamp: "2026-01-01", parentSession: "/sessions/old.jsonl" } },
    { path: "/sessions/old.jsonl", modified: "2026-01-01", header: { id: "old", cwd: "/main", timestamp: "2026-01-01" } },
  ];
  discovery = async () => files;
  invalidateSessionListCache();
}

test("catalog returns metadata and lineage without reading any titles or transcripts", async () => {
  reset();
  const sessions = await listAllSessions();
  assert.equal(discoveries, 1);
  assert.deepEqual(titleReads, []);
  assert.equal(sessions[0].parentSessionId, "old");
  assert.equal(sessions[0].projectRoot, "/main");
  assert.equal(sessions[0].titleLoaded, false);
  assert.equal(sessions[0].messageCount, undefined);
  assert.equal(await resolveSessionPath("new"), files[0].path.replaceAll("/", process.platform === "win32" ? "\\" : "/"));
  await listAllSessions();
  assert.equal(discoveries, 1);
});

test("only explicitly requested existing IDs load titles", async () => {
  reset();
  assert.deepEqual(await loadSessionTitles(["old", "old", "../../unrelated"]), [{ id: "old", name: "title", firstMessage: "" }]);
  assert.deepEqual(titleReads, ["old"]);
});

test("concurrent discoveries coalesce; invalidated work cannot repopulate cache", async () => {
  reset();
  const gate = Promise.withResolvers();
  discovery = () => gate.promise;
  const first = listAllSessions();
  const second = listAllSessions();
  assert.equal(discoveries, 1);
  invalidateSessionListCache();
  discovery = async () => [];
  await listAllSessions();
  gate.resolve(files);
  await Promise.all([first, second]);
  assert.deepEqual(await listAllSessions(), []);
  assert.equal(discoveries, 2);
});

test("catalog invalidation notifies and unsubscribes sidebar listeners", () => {
  let updates = 0;
  const unsubscribe = subscribeSessionListChanges(() => updates++);
  invalidateSessionListCache();
  unsubscribe();
  invalidateSessionListCache();
  assert.equal(updates, 1);
});
