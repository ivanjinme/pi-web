import assert from 'node:assert/strict';
import test from 'node:test';
import { createJiti } from 'jiti';
const jiti = createJiti(import.meta.url);
const { EditorState, Transaction } = await jiti.import('@codemirror/state');
const { history, undo, redo, isolateHistory } = await jiti.import('@codemirror/commands');
const { createSourceTextExtension, sourceTextField, externalSourceText } = await jiti.import('./source-editor-state.ts');
import { sourceLineRange } from './source-lines.ts';

function editor(raw, historyConfig = {}) {
  let state = EditorState.create({ doc: raw, extensions: [history(historyConfig), createSourceTextExtension(raw)] });
  const target = { get state() { return state; }, dispatch(tr) { state = tr.state; } };
  return {
    target,
    get state() { return state; },
    get raw() { return state.field(sourceTextField).text; },
    edit(changes, userEvent = 'input.type', isolated = true) {
      target.dispatch(state.update({ changes, userEvent, annotations: isolated ? isolateHistory.of('full') : [] }));
    },
    external(raw) {
      target.dispatch(state.update({ changes: { from: 0, to: state.doc.length, insert: raw },
        annotations: [externalSourceText.of(raw), Transaction.addToHistory.of(false)] }));
    },
  };
}

test('pasting LF, CRLF and CR keeps document positions, line numbers and subsequent edits aligned', () => {
  for (const newline of ['\n', '\r\n', '\r']) {
    for (const pastedNewline of ['\n', '\r\n', '\r']) {
      const e = editor(`A${newline}B`);
      // 使用与 CodeMirror clipboard 路径相同的 toText 转换。
      e.edit({ from: 0, insert: e.state.toText(`X${pastedNewline}Y`) }, 'input.paste');
      assert.equal(e.state.doc.toString(), 'X\nYA\nB');
      assert.equal(e.state.doc.lines, 3);
      assert.equal(e.raw, `X${newline}YA${newline}B`);
      assert.deepEqual(sourceLineRange(e.state.doc, 2, 3), { startLine: 2, endLine: 2 });
      e.edit({ from: 2, to: 3, insert: 'Z' });
      assert.equal(e.raw, `X${newline}ZA${newline}B`);
      assert.ok(undo(e.target));
      assert.equal(e.raw, `X${newline}YA${newline}B`);
      assert.ok(undo(e.target));
      assert.equal(e.raw, `A${newline}B`);
      assert.ok(redo(e.target));
      assert.equal(e.raw, `X${newline}YA${newline}B`);
    }
  }
});

test('delete-all undo and redo preserve BOM, mixed separators and trailing newlines exactly', () => {
  const original = '\ufeffone\r\ntwo\nthree\rfour\r\n\n';
  const e = editor(original);
  e.edit({ from: 0, to: e.state.doc.length, insert: '' }, 'delete.selection');
  assert.equal(e.raw, '');
  for (let i = 0; i < 3; i++) {
    assert.ok(undo(e.target));
    assert.equal(e.raw, original);
    assert.ok(redo(e.target));
    assert.equal(e.raw, '');
  }
  assert.ok(undo(e.target));
  e.edit({ from: e.state.doc.length, insert: '\n' });
  assert.equal(e.raw, original + '\r\n');
});

test('grouped deletes and replacements restore each original newline without reverting text', () => {
  const original = 'a\r\nb\nc\rd\r\ne';
  const e = editor(original);
  e.edit({ from: 3, to: 4 }, 'delete.backward', false);
  e.edit({ from: 3, to: 5 }, 'delete.backward', false);
  e.edit({ from: 2, to: 3, insert: 'B' }, 'input.type', false);
  const modified = e.raw;
  assert.equal(modified, 'a\r\nBd\r\ne');
  assert.ok(undo(e.target));
  assert.equal(e.raw, original);
  assert.ok(redo(e.target));
  assert.equal(e.raw, modified);
});

test('multi-range deletion restores newline styles at the correct positions', () => {
  const original = 'a\r\nb\nc\rd\r\ne';
  const e = editor(original);
  e.edit([{ from: 1, to: 2 }, { from: 5, to: 6 }], 'delete.selection');
  assert.equal(e.raw, 'ab\ncd\r\ne');
  assert.ok(undo(e.target));
  assert.equal(e.raw, original);
  assert.ok(redo(e.target));
  assert.equal(e.raw, 'ab\ncd\r\ne');
});

test('grouped deletion of a newly inserted newline does not overwrite a surviving original separator', () => {
  const original = 'a\r\nb\nc';
  const e = editor(original);
  e.edit({ from: 3, insert: '\n' }, 'input.type', false);
  e.edit({ from: 3, to: 4 }, 'delete.backward', false);
  e.edit({ from: 3, to: 4 }, 'delete.backward', false);
  assert.equal(e.raw, 'a\r\nbc');
  assert.ok(undo(e.target));
  assert.equal(e.raw, original);
  assert.ok(redo(e.target));
  assert.equal(e.raw, 'a\r\nbc');
});

test('random grouped edits preserve raw newline bytes across undo and redo', () => {
  let seed = 12345;
  const random = (max) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % max; };
  for (let round = 0; round < 50; round++) {
    const original = '\ufeffa\r\nb\nc\rd\r\ne\n';
    const e = editor(original, { joinToEvent: () => true });
    for (let i = 0; i < 25; i++) {
      const from = random(e.state.doc.length + 1);
      const to = from + random(e.state.doc.length - from + 1);
      const insert = ['', 'X', '\n', 'Y\r\nZ', '\r'][random(5)];
      e.edit({ from, to, insert }, 'input.type', false);
      assert.equal(e.state.doc.toString(), e.raw.replace(/\r\n|\r/g, '\n'));
    }
    const final = e.raw;
    assert.ok(undo(e.target));
    assert.equal(e.raw, original, `round ${round} undo`);
    assert.ok(redo(e.target));
    assert.equal(e.raw, final, `round ${round} redo`);
  }
});

test('external synchronization imports raw separators without adding a user edit to history', () => {
  const e = editor('old\ntext');
  const incoming = '\ufeffnew\rcontent\r';
  e.external(incoming);
  assert.equal(e.raw, incoming);
  assert.equal(e.state.doc.toString(), '\ufeffnew\ncontent\n');
  assert.equal(undo(e.target), false);
  e.edit({ from: 1, to: 4, insert: 'NEW' });
  assert.equal(e.raw, '\ufeffNEW\rcontent\r');
  assert.ok(undo(e.target));
  assert.equal(e.raw, incoming);
});
