import assert from 'node:assert/strict';
import test from 'node:test';
import { EditorState, EditorSelection } from '@codemirror/state';
import { applySourceChanges, sourceLineRange } from './source-lines.ts';
test('line references exclude unselected cross-line boundaries', () => {
  const doc = EditorState.create({ doc: 'one\ntwo\nthree' }).doc;
  assert.equal(sourceLineRange(doc, 1, 1), null);
  assert.deepEqual(sourceLineRange(doc, 0, 4), { startLine: 1, endLine: 1 });
  assert.deepEqual(sourceLineRange(doc, 3, 7), { startLine: 2, endLine: 2 });
  assert.deepEqual(sourceLineRange(doc, 1, 9), { startLine: 1, endLine: 3 });
});
test('near-limit source documents support incremental edits and read-only transactions without per-line rendering', () => {
  const text = 'a long source line for testing\n'.repeat(8000);
  assert.ok(Buffer.byteLength(text) < 256 * 1024);
  const initial = EditorState.create({ doc: text, selection: EditorSelection.cursor(10) });
  const next = initial.update({ changes: { from: 10, insert: '中' } }).state;
  assert.equal(next.doc.lines, 8001);
  assert.equal(next.doc.sliceString(10, 11), '中');
  assert.equal(initial.doc.length + 1, next.doc.length);
  const readonly = EditorState.create({ doc: text, extensions: [EditorState.readOnly.of(true)] });
  assert.equal(readonly.readOnly, true);
  assert.equal(readonly.doc.toString(), text);
});
test('Source edits preserve untouched BOM and mixed CRLF/LF/CR byte sequences', () => {
  const raw='\ufeffone\r\ntwo\nthree\rfour';
  const doc=EditorState.create({doc: raw.replaceAll('\r\n','\n').replaceAll('\r','\n')}).doc;
  assert.equal(doc.lines,4);
  assert.equal(applySourceChanges(raw,[{from:5,to:8,insert:'TWO'}],'\r\n'),'\ufeffone\r\nTWO\nthree\rfour');
  assert.equal(applySourceChanges(raw,[{from:1,to:1,insert:'X'},{from:9,to:14,insert:'THREE'}],'\r\n'),'\ufeffXone\r\ntwo\nTHREE\rfour');
});
