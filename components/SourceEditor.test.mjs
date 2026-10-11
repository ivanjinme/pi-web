import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { createJiti } from 'jiti';

const jiti = createJiti(import.meta.url);
const { EditorState, Compartment, Prec, Transaction } = await jiti.import('@codemirror/state');
const { javascript } = await jiti.import('@codemirror/lang-javascript');
const { undo, redo } = await jiti.import('@codemirror/commands');
const { EditorView, keymap } = await jiti.import('@codemirror/view');
const { basicSetup } = await jiti.import('codemirror');
const { createSourceTextExtension, sourceTextField, externalSourceText } = await jiti.import('../lib/source-editor-state.ts');
const { sourceLineRange } = await jiti.import('../lib/source-lines.ts');
const source = readFileSync(new URL('./SourceEditor.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('SourceEditor.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let setup;
let sync;
function visit(node) {
  if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useEffect' &&
      node.arguments[0].getText(ast).includes('new EditorView')) setup = node.arguments[0].getText(ast);
  if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useLayoutEffect' &&
      node.arguments[0].getText(ast).includes('const instance')) sync = node.arguments[0].getText(ast);
  ts.forEachChild(node, visit);
}
visit(ast);
assert.ok(setup);
assert.ok(sync);

// 执行实际组件的实例生命周期和 updateListener，不把这些测试当成浏览器验收。
function fixture(value = 'one\r\ntwo\nthree') {
  let selection = { startLine: 1, endLine: 2 };
  const writes = [];
  const mentions = [];
  const createState = { current: null };
  const config = { current: new Compartment() };
  const languageConfig = { current: new Compartment() };
  let flushes = 0;
  const view = { current: null };
  class TestEditorView {
    static updateListener = EditorView.updateListener;
    static domEventHandlers = EditorView.domEventHandlers;
    constructor({ state }) { this.state = state; this.destroyed = false; this.dispatch = this.dispatch.bind(this); }
    dispatch(spec) {
      const startState = this.state;
      const tr = spec instanceof Transaction ? spec : startState.update(spec);
      this.state = tr.state;
      for (const listener of this.state.facet(EditorView.updateListener)) listener({
        state: this.state, startState, transactions: [tr], docChanged: tr.docChanged, selectionSet: Boolean(tr.selection),
      });
    }
    setState(state) { this.state = state; }
    destroy() { this.destroyed = true; }
  }
  const context = {
    host: { current: {} }, view,
    latest: { current: { value, onChange: (text) => writes.push(text), onSelection: (range) => { selection = range; },
      onMention: (range) => mentions.push(range),
      onComposition() {}, onFlush: () => { flushes++; } } },
    config, languageConfig, createState, Prec, Transaction,
    EditorView: TestEditorView, EditorState, basicSetup, keymap, sourceLineRange,
    createSourceTextExtension, sourceTextField, externalSourceText,
  };
  const compile = (callback) => ts.transpileModule(`const callback = ${callback};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText + '\ncallback';
  const mount = runInNewContext(compile(setup), context);
  return { mount, view, writes, mentions, config, languageConfig,
    external(value) { runInNewContext(compile(sync), { ...context, props: { value } })(); },
    get selection() { return selection; }, get flushes() { return flushes; } };
}

test('switching Source to Preview and back clears the previous line mention selection', () => {
  const f = fixture();
  const close = f.mount();
  assert.equal(f.selection, null);
  f.view.current.dispatch({ selection: { anchor: 0, head: 7 } });
  assert.deepEqual({ ...f.selection }, { startLine: 1, endLine: 2 });
  const previous = f.view.current;
  close();
  assert.equal(f.selection, null);
  assert.equal(previous.destroyed, true);
  const closeAgain = f.mount();
  assert.equal(f.selection, null);
  assert.equal(f.view.current.state.selection.main.empty, true);
  closeAgain();
  assert.equal(f.flushes, 2);
  assert.deepEqual(f.writes, []);
});

test('line mentions take precedence over basicSetup syntax-selection shortcuts', () => {
  const f = fixture('const value = 1;');
  const close = f.mount();
  const v = f.view.current;
  v.dispatch({ effects: f.languageConfig.current.reconfigure(javascript()), selection: { anchor: 6, head: 11 } });
  for (const binding of v.state.facet(keymap).flat().filter((binding) => binding.key === 'Mod-i')) {
    if (binding.run(v)) break;
  }
  assert.deepEqual(f.mentions.map((range) => ({ ...range })), [{ startLine: 1, endLine: 1 }]);
  assert.equal(v.state.selection.main.from, 6);
  assert.equal(v.state.selection.main.to, 11);
  assert.deepEqual(f.writes, []);
  close();
});

test('external updates after deleting all text reset obsolete history and preserve configuration', () => {
  const f = fixture('\ufeffone\r\ntwo\nthree');
  const close = f.mount();
  const v = f.view.current;
  const language = javascript();
  const config = EditorState.tabSize.of(8);
  v.dispatch({ effects: [f.languageConfig.current.reconfigure(language), f.config.current.reconfigure(config)] });
  v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: '' }, userEvent: 'delete.selection' });
  assert.deepEqual(f.writes, ['']);
  const incoming = '\ufeffagent\r\nupdated\r\n';
  f.external(incoming);
  assert.equal(v.state.field(sourceTextField).text, incoming);
  assert.equal(f.languageConfig.current.get(v.state), language);
  assert.equal(f.config.current.get(v.state), config);
  assert.equal(undo(v), false);
  assert.equal(redo(v), false);
  assert.deepEqual(f.writes, ['']);
  assert.equal(f.selection, null);
  v.dispatch({ changes: { from: 1, to: 6, insert: 'NEW' }, userEvent: 'input.type' });
  assert.equal(v.state.field(sourceTextField).text, '\ufeffNEW\r\nupdated\r\n');
  assert.ok(undo(v));
  assert.equal(v.state.field(sourceTextField).text, incoming);
  close();
});

test('different external content clears redo without resurrecting replaced local text', () => {
  const f = fixture('old\r\ntext');
  const close = f.mount();
  const v = f.view.current;
  v.dispatch({ changes: { from: 0, to: 3, insert: 'NEW' }, userEvent: 'input.type' });
  assert.ok(undo(v));
  const writes = [...f.writes];
  f.external('agent\ncontent');
  assert.equal(undo(v), false);
  assert.equal(redo(v), false);
  assert.equal(v.state.field(sourceTextField).text, 'agent\ncontent');
  assert.deepEqual(f.writes, writes);
  close();
});

test('same-content external updates preserve state, selection and newline undo history', () => {
  const f = fixture('one\r\ntwo\nthree');
  const close = f.mount();
  const v = f.view.current;
  v.dispatch({ changes: { from: 3, to: 4, insert: '' }, selection: { anchor: 0, head: 3 }, userEvent: 'delete.selection' });
  const previous = v.state;
  f.external(v.state.field(sourceTextField).text);
  assert.equal(v.state, previous);
  assert.equal(v.state.selection.main.to, 3);
  assert.ok(undo(v));
  assert.equal(v.state.field(sourceTextField).text, 'one\r\ntwo\nthree');
  close();
});

test('Source callbacks submit the raw StateField text and do not save external imports', () => {
  const f = fixture('A\nB');
  const close = f.mount();
  f.view.current.dispatch({ changes: { from: 0, insert: f.view.current.state.toText('X\r\nY') }, userEvent: 'input.paste' });
  assert.deepEqual(f.writes, ['X\nYA\nB']);
  f.view.current.dispatch({ changes: { from: 2, to: 3, insert: 'Z' } });
  assert.deepEqual(f.writes, ['X\nYA\nB', 'X\nZA\nB']);
  f.view.current.dispatch({ changes: { from: 0, to: f.view.current.state.doc.length, insert: 'external\r\ntext' },
    annotations: externalSourceText.of('external\r\ntext') });
  assert.equal(f.view.current.state.field(sourceTextField).text, 'external\r\ntext');
  assert.equal(f.writes.length, 2);
  close();
});
