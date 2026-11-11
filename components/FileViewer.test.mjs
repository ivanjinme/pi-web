import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("./FileViewer.tsx", import.meta.url), "utf8");

function viewerSource(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1);
  const next = source.indexOf("\nfunction ", start + 1);
  return source.slice(start, next === -1 ? undefined : next);
}

for (const name of ["ImageViewer", "AudioViewer", "DocumentViewer", "TextFileViewer"]) {
  test(`${name} suspends its watch without resetting retained view state`, () => {
    const viewer = viewerSource(name);
    assert.match(viewer, /active = true/);
    const watchStart = viewer.lastIndexOf("  useEffect(() => {", viewer.indexOf("const es = new EventSource"));
    const watchEnd = viewer.indexOf("\n  }, [", watchStart);
    const watch = viewer.slice(watchStart, viewer.indexOf(";", watchEnd) + 1);
    if (name === "TextFileViewer") {
      assert.match(watch, /if \(!active\) \{\s*refreshOnActivateRef\.current = true;\s*return;\s*\}/);
      assert.match(watch, /if \(refreshOnActivateRef\.current\)/);
    } else {
      assert.match(watch, /if \(!active\) return;/);
      assert.doesNotMatch(viewer, /refreshOnActivateRef/);
      assert.doesNotMatch(watch.slice(0, watch.indexOf("const es = new EventSource")), /setBust|setError|refreshMetadata/);
    }
    assert.match(watch, /return \(\) => \{[\s\S]*es\.close\(\)/);
    assert.match(watch, /\}, \[active,/);
    assert.doesNotMatch(watch.slice(0, watch.indexOf("const es = new EventSource")), /set(?:Loading|DisplayMode|WrapLines|MarkdownUnsafe|SelectedLineRange|NaturalSize|Duration)\(/);
    assert.doesNotMatch(watch, /setBust\(0\)|setSize\(null\)/);
  });
}

for (const name of ["ImageViewer", "AudioViewer", "DocumentViewer"]) {
  test(`${name} compares revisions across reconnects without resetting unchanged media`, () => {
    const viewer = viewerSource(name);
    const start = viewer.lastIndexOf("  useEffect(() => {", viewer.indexOf("const es = new EventSource"));
    const end = viewer.indexOf("\n  }, [", start);
    const body = viewer.slice(start + "  useEffect(() => {".length, end);
    const compiled = ts.transpileModule(`function watch() {${body}\n}`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const revisionRef = { current: null };
    const hasSubscribedRef = { current: false };
    const esRef = { current: null };
    const resetStart = viewer.indexOf("  useEffect(() => {");
    const resetEnd = viewer.indexOf("\n  }, [", resetStart);
    const reset = viewer.slice(resetStart, resetEnd);
    const resetStatements = reset.match(/(?:revisionRef|hasSubscribedRef)\.current = (?:null|false);/g);
    assert.equal(resetStatements?.length, 2, "file/source context reset must clear revision and subscription flag");
    const resetContext = () => new Function("revisionRef", "hasSubscribedRef", resetStatements.join("\n"))(revisionRef, hasSubscribedRef);
    const state = { bust: 0, error: "retained error", duration: 42, size: null };
    const calls = [];
    const setter = (key) => (value) => {
      calls.push(key);
      state[key] = typeof value === "function" ? value(state[key]) : value;
    };
    const connections = [];
    class EventSource {
      constructor() { this.listeners = {}; connections.push(this); }
      addEventListener(event, callback) { this.listeners[event] = callback; }
      emit(event, revision) { this.listeners[event]({ data: JSON.stringify(revision) }); }
      close() { this.closed = true; }
    }
    const run = (active) => new Function(
      "active", "EventSource", "revisionRef", "hasSubscribedRef", "esRef", "setWatching", "setSize", "setError", "setBust", "setDuration",
      "getFileApiUrl", "filePath", "sourceSessionId", "isPdf", "DOCX_PREVIEW_MAX_BYTES",
      `${compiled}\nreturn watch();`,
    )(active, EventSource, revisionRef, hasSubscribedRef, esRef, () => {}, setter("size"), setter("error"), setter("bust"), setter("duration"),
      () => "/watch", "/media", null, false, 10 * 1024 * 1024);
    const initial = { mtime: "2026-01-01T00:00:00.000Z", size: 100 };
    let cleanup = run(true);
    connections.at(-1).emit("connected", initial);
    assert.equal(state.bust, 0, "initial connection must not reload");
    calls.length = 0;
    for (let i = 0; i < 2; i++) {
      cleanup();
      assert.equal(connections.at(-1).closed, true);
      assert.equal(run(false), undefined);
      cleanup = run(true);
      connections.at(-1).emit("connected", initial);
    }
    assert.deepEqual(calls, [], "unchanged reconnect must not reset any media state");
    assert.equal(state.error, "retained error");
    assert.equal(state.duration, 42);
    const changed = { ...initial, mtime: "2026-01-01T00:00:01.000Z" };
    connections.at(-1).emit("connected", changed);
    assert.equal(state.bust, 1, "mtime-only changes missed while inactive must reload");
    assert.equal(state.error, null);
    if (name === "AudioViewer") assert.equal(state.duration, null);
    calls.length = 0;
    connections.at(-1).emit("change", changed);
    assert.deepEqual(calls, [], "duplicate changes must not reload");
    connections.at(-1).emit("change", { ...changed, size: 101 });
    assert.equal(state.bust, 2, "size-only changes must reload");
    assert.equal(state.size, 101);
    assert.throws(() => connections.at(-1).listeners.change({ data: "invalid JSON" }), SyntaxError);
    if (name === "DocumentViewer") {
      connections.at(-1).emit("connected", { ...changed, size: 11 * 1024 * 1024 });
      assert.equal(state.error, "DOCX too large for preview (>10MB)");
    }
    cleanup();

    resetContext();
    assert.equal(hasSubscribedRef.current, false);
    assert.equal(revisionRef.current, null);
    const beforeRace = state.bust;
    cleanup = run(true);
    cleanup(); // Switch away before the first connected event establishes a baseline.
    assert.equal(revisionRef.current, null);
    assert.equal(run(false), undefined);
    cleanup = run(true);
    connections.at(-1).emit("connected", changed);
    assert.equal(state.bust, beforeRace + 1, "reconnect without a baseline must reload potentially stale media");
    calls.length = 0;
    connections.at(-1).emit("connected", changed);
    assert.deepEqual(calls, [], "the newly established baseline must prevent further reloads");
    cleanup();

    resetContext();
    cleanup = run(true);
    connections.at(-1).emit("connected", initial);
    assert.equal(state.bust, beforeRace + 1, "a new file/source context must not count as a reconnect");
    cleanup();
  });
}

test("watch connected events include the same revision fields as change events", async () => {
  const route = await readFile(new URL("../app/api/files/[...path]/route.ts", import.meta.url), "utf8");
  assert.match(route, /send\("connected", \{ filePath, mtime: stat\.mtime\.toISOString\(\), size: stat\.size \}\)/);
  assert.match(route, /send\("change", \{ mtime: s\.mtime\.toISOString\(\), size: s\.size \}\)/);
});

test("FileViewer forwards active to every retained viewer", () => {
  assert.match(source, /active\?: boolean;/);
  const wrapper = source.slice(source.indexOf("export function FileViewer("), source.indexOf("function TextFileViewer("));
  for (const name of ["ImageViewer", "AudioViewer", "DocumentViewer", "TextFileViewer"]) {
    assert.match(wrapper, new RegExp(`<${name}[^>]*active=\\{active\\}`));
  }
});

test("text resume uses draft-safe refresh and keeps deleted diffs unwatched", () => {
  const viewer = viewerSource("TextFileViewer");
  assert.match(viewer, /await fileDrafts\.refresh\(targetPath, sourceSessionId\)/);
  assert.match(viewer, /if \(refreshOnActivateRef\.current\) \{[\s\S]*?void fetchContent\(filePath\);\s*scheduleGitDiff\(filePath\);\s*\}\s*if \(isDeletedDiff\) return;/);
  const resetStart = viewer.indexOf("    setLoading(true);");
  const resetEnd = viewer.indexOf("\n  }, [", resetStart);
  const reset = viewer.slice(resetStart, viewer.indexOf(";", resetEnd) + 1);
  assert.match(reset, /setDisplayMode\("source"\)/);
  assert.match(reset, /setWrapLines\(false\)/);
  assert.doesNotMatch(reset.slice(reset.lastIndexOf("}, [")), /active/);
});

test("large source previews bypass the per-line syntax highlighter", () => {
  assert.match(source, /const SOURCE_HIGHLIGHT_MAX_LINES = 1_000;/);
  assert.match(source, /const useLightweightSource = lines\.length > SOURCE_HIGHLIGHT_MAX_LINES;/);

  const lightweightStart = source.indexOf(") : useLightweightSource ? (");
  const syntaxStart = source.indexOf("<SyntaxHighlighter", lightweightStart);
  assert.notEqual(lightweightStart, -1);
  assert.notEqual(syntaxStart, -1);

  const lightweightSource = source.slice(lightweightStart, syntaxStart);
  assert.match(lightweightSource, /className="file-source-view is-lightweight"/);
  assert.match(lightweightSource, /lines\.map\(\(line, lineIndex\) =>/);
  assert.match(lightweightSource, /className="file-source-line"/);
  assert.match(lightweightSource, /className="file-source-line-content"/);
  assert.match(lightweightSource, /style=\{FILE_LINE_NUMBER_STYLE\}/);
});
