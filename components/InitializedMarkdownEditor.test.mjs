import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { createJiti } from 'jiti';
import ts from 'typescript';
import { Realm } from '@mdxeditor/gurx';
import { corePlugin, rootEditor$, markdown$ } from '@mdxeditor/editor';
import { $getRoot, HISTORY_PUSH_TAG, UNDO_COMMAND, REDO_COMMAND } from 'lexical';
import { isSafeMarkdownRoundTrip, markdownEnvelope, markdownFallbackReason, restoreMarkdownEnvelope } from '../lib/markdown-editing.ts';

const { FileDraftCoordinator } = await createJiti(import.meta.url).import('../lib/file-draft.ts');
const source = readFileSync(new URL('./InitializedMarkdownEditor.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('InitializedMarkdownEditor.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let changeHandler;
let syncEffect;
function visit(node) {
  if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useLayoutEffect' &&
      node.arguments[0].getText(ast).includes('const incoming')) {
    syncEffect = node.arguments[0].getText(ast);
  }
  if (ts.isJsxAttribute(node) && node.name.getText(ast) === 'onChange') {
    changeHandler = node.initializer.expression.getText(ast);
  }
  ts.forEachChild(node, visit);
}
visit(ast);
assert.ok(changeHandler);
assert.ok(syncEffect);

// 执行组件实际回调，验证草稿交接；不模拟 MDXEditor 的 DOM 或解析过程。
async function createEditorFixture(original = 'Old paragraph.\n') {
  const path = '/note.md';
  const writes = [];
  const fallbacks = [];
  const coordinator = new FileDraftCoordinator(async (_path, text) => { writes.push(text); },
    async () => ({ content: original, language: 'markdown', editable: true, size: Buffer.byteLength(original) }));
  await coordinator.refresh(path);
  const syncing = { current: false };
  const lastText = { current: original };
  const lastSerialized = { current: markdownEnvelope(original).body };
  const onChange = runInNewContext(`(${changeHandler})`, {
    props: {
      filePath: path,
      onChange: (text) => coordinator.edit(path, text),
      onUnsafe: (reason) => fallbacks.push({ reason, text: coordinator.get(path).text }),
    },
    ready: true, syncing, lastText, lastSerialized,
    markdownFallbackReason, restoreMarkdownEnvelope, isSafeMarkdownRoundTrip,
  });
  return { path, coordinator, writes, fallbacks, syncing, lastText, onChange };
}

const fallbackCases = [
  {
    name: 'price',
    markdown: 'Price: $10\n',
    expected: 'Price: $10\n',
    reason: 'Math / LaTeX',
  },
  {
    name: 'pasted expression',
    markdown: 'A pasted paragraph with {name} and extra content.\n',
    expected: 'A pasted paragraph with {name} and extra content.\n',
    reason: 'HTML / JSX',
  },
  {
    name: 'BOM and CRLF',
    original: '\ufeffOld paragraph.\r\n\r\n',
    markdown: 'Price: $10\n\nAnother paragraph.\n',
    expected: '\ufeffPrice: $10\r\n\r\nAnother paragraph.\r\n\r\n',
    reason: 'Math / LaTeX',
  },
];

for (const { name, original, markdown, expected, reason } of fallbackCases) {
  test(`preserves ${name} input in the shared draft before preview fallback`, async function () {
    const fixture = await createEditorFixture(original);
    fixture.onChange(markdown, false);
    assert.equal(fixture.coordinator.get(fixture.path).text, expected);
    assert.deepEqual(fixture.fallbacks, [{ reason, text: expected }]);
    assert.equal(fixture.lastText.current, expected);
    assert.equal(fixture.syncing.current, true);
    // 降级卸载后的旧回调不能覆盖已交接的输入。
    fixture.onChange('Late editor output', false);
    await fixture.coordinator.flush(fixture.path);
    assert.deepEqual(fixture.writes, [expected]);
    assert.equal(fixture.coordinator.get(fixture.path).status, 'saved');
  });
}

test('unsafe initialization preserves the original draft without saving normalized output', async function () {
  const fixture = await createEditorFixture();
  fixture.onChange('', true);
  await fixture.coordinator.flush(fixture.path);
  assert.equal(fixture.coordinator.get(fixture.path).text, 'Old paragraph.\n');
  assert.deepEqual(fixture.writes, []);
  assert.deepEqual(fixture.fallbacks, [{ reason: 'Markdown round-trip', text: 'Old paragraph.\n' }]);
});

// 执行实际同步 effect 和回调；帧调度与导入用替身验证时序，不模拟解析器或 DOM。
function createSyncFixture(original = 'A\n') {
  let ready = false;
  let output = markdownEnvelope(original).body;
  let baseline = { revision: 0, markdown: output, focused: false };
  let cleanup;
  let frameId = 0;
  let focused = false;
  const frames = new Map();
  const imports = [];
  const changes = [];
  const fallbacks = [];
  const syncing = { current: true };
  const lastText = { current: original };
  const lastSerialized = { current: output };
  let onChange;
  const props = {
    filePath: '/note.md', value: original,
    onChange: (text) => changes.push(text), onUnsafe: (reason) => fallbacks.push(reason),
  };
  const latest = { current: props };
  const editor = { current: { getMarkdown: () => output } };
  const compiledEffect = ts.transpileModule(`const effect = ${syncEffect};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  function render(value) {
    cleanup?.();
    const nextProps = { ...props, value };
    latest.current = nextProps;
    const context = {
      props: nextProps, ready, syncing, lastText, lastSerialized, latest, editor,
      host: { current: { querySelector: () => true, contains: () => focused } },
      document: { activeElement: null },
      markdownEnvelope, isSafeMarkdownRoundTrip, markdownFallbackReason, restoreMarkdownEnvelope,
      setReady: (value) => { ready = value; },
      setBaseline: (update) => {
        baseline = update(baseline);
        imports.push(baseline.markdown);
        output = baseline.markdown;
        onChange(output, true);
      },
      requestAnimationFrame: (callback) => { frames.set(++frameId, callback); return frameId; },
      cancelAnimationFrame: (id) => frames.delete(id),
    };
    onChange = runInNewContext(`(${changeHandler})`, context);
    cleanup = runInNewContext(`${compiledEffect}\neffect`, context)();
  }
  return {
    render, imports, changes, fallbacks,
    validate() { const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback(); },
    change(markdown) { onChange(markdown, false); },
    get ready() { return ready; },
    get output() { return output; },
    get text() { return lastText.current; },
    get serialized() { return lastSerialized.current; },
    get revision() { return baseline.revision; },
    setFocused(value) { focused = value; },
    get restoreFocus() { return baseline.focused; },
  };
}

test('imports the latest external Markdown when another update arrives before validation', () => {
  const f = createSyncFixture();
  f.render('A\n'); f.validate(); f.render('A\n');
  f.render('B\n');
  assert.equal(f.ready, false);
  // ready=false 的重渲染不应重复导入 B，但也不能阻止随后导入 C。
  f.render('B\n'); f.render('C\n'); f.validate(); f.render('C\n');
  assert.deepEqual(f.imports, ['B', 'C']);
  assert.equal(f.output, 'C');
  assert.equal(f.text, 'C\n');
  assert.equal(f.serialized, 'C');
  assert.equal(f.ready, true);
  assert.deepEqual(f.fallbacks, []);
  assert.deepEqual(f.changes, []);
});

test('imports external Markdown arriving before initial validation without saving', () => {
  const f = createSyncFixture();
  f.render('A\n'); f.render('Latest\n'); f.validate(); f.render('Latest\n');
  assert.deepEqual(f.imports, ['Latest']);
  assert.equal(f.ready, true);
  assert.equal(f.output, 'Latest');
  assert.deepEqual(f.fallbacks, []);
  assert.deepEqual(f.changes, []);
});

test('initial validation and local draft echoes do not reimport Markdown', () => {
  const f = createSyncFixture();
  f.render('A\n'); f.validate(); f.render('A\n');
  f.change('User input'); f.render('User input\n');
  assert.equal(f.ready, true);
  assert.deepEqual(f.imports, []);
  assert.deepEqual(f.changes, ['User input\n']);
  assert.deepEqual(f.fallbacks, []);
});

test('external Markdown only requests autofocus when the replaced editor held focus', () => {
  const f = createSyncFixture();
  f.render('A\n'); f.validate(); f.render('A\n');
  f.setFocused(true);
  f.render('B\n'); f.validate(); f.render('B\n');
  assert.equal(f.restoreFocus, true);
  f.setFocused(false);
  f.render('C\n'); f.validate(); f.render('C\n');
  assert.equal(f.restoreFocus, false);
  assert.equal(f.revision, 2);
  assert.deepEqual(f.changes, []);
});

// 使用实际 MDXEditor 解析、序列化和 Lexical 历史；只替代 React 重挂载、DOM 与帧调度。
async function createHistoryFixture(t) {
  const path = '/note.md';
  let disk = 'Old paragraph.\n';
  const writes = [];
  const fallbacks = [];
  const coordinator = new FileDraftCoordinator(async (_path, text) => { disk = text; writes.push(text); },
    async () => ({ content: disk, language: 'markdown', editable: true, size: Buffer.byteLength(disk) }));
  await coordinator.refresh(path);

  let ready = false;
  let cleanup;
  let onChange;
  let frameId = 0;
  let realm;
  let lexicalEditor;
  let baseline = { revision: 0, markdown: markdownEnvelope(disk).body, focused: false };
  const frames = new Map();
  const syncing = { current: true };
  const lastText = { current: disk };
  const lastSerialized = { current: baseline.markdown };
  const props = { filePath: path, value: disk, onChange: (text) => coordinator.edit(path, text),
    onUnsafe: (reason) => fallbacks.push(reason) };
  const latest = { current: props };
  const editor = { current: null };
  function mount() {
    lexicalEditor?.dispose();
    realm = new Realm();
    const plugin = corePlugin({ initialMarkdown: baseline.markdown,
      onChange: (markdown, initial) => onChange?.(markdown, initial) });
    plugin.init(realm);
    plugin.postInit(realm);
    lexicalEditor = realm.getValue(rootEditor$);
    editor.current = { getMarkdown: () => realm.getValue(markdown$) };
  }
  mount();
  t.after(async () => { cleanup?.(); await coordinator.flush(path); lexicalEditor.dispose(); });
  const compiledEffect = ts.transpileModule(`const effect = ${syncEffect};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  function render() {
    cleanup?.();
    const nextProps = { ...props, value: coordinator.get(path).text };
    latest.current = nextProps;
    const context = {
      props: nextProps, ready, syncing, lastText, lastSerialized, latest, editor,
      host: { current: { querySelector: () => true, contains: () => false } },
      document: { activeElement: null },
      markdownEnvelope, isSafeMarkdownRoundTrip, markdownFallbackReason, restoreMarkdownEnvelope,
      setReady: (value) => { ready = value; },
      setBaseline: (update) => { baseline = update(baseline); mount(); },
      requestAnimationFrame: (callback) => { frames.set(++frameId, callback); return frameId; },
      cancelAnimationFrame: (id) => frames.delete(id),
    };
    onChange = runInNewContext(`(${changeHandler})`, context);
    cleanup = runInNewContext(`${compiledEffect}\neffect`, context)();
  }
  const turn = () => new Promise((resolve) => setImmediate(resolve));
  async function validate() {
    await turn();
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback();
    render();
    assert.equal(ready, true);
    assert.deepEqual(fallbacks, []);
  }
  async function command(command) {
    lexicalEditor.dispatchCommand(command, undefined);
    await turn();
    render();
    await coordinator.flush(path);
  }
  render();
  await validate();
  return {
    path, coordinator, writes,
    get disk() { return disk; },
    get revision() { return baseline.revision; },
    get editor() { return lexicalEditor; },
    get output() { return editor.current.getMarkdown(); },
    async edit(text) {
      // 模拟用户先定位光标，为新编辑器建立可撤销的初始正文基线。
      lexicalEditor.update(() => { $getRoot().selectEnd(); }, { discrete: true });
      lexicalEditor.update(() => { $getRoot().getFirstChild().getFirstChild().setTextContent(text); },
        { tag: HISTORY_PUSH_TAG, discrete: true });
      await turn();
      render();
      await coordinator.flush(path);
    },
    async refresh(text = disk) { disk = text; await coordinator.refresh(path); render(); await validate(); },
    undo: () => command(UNDO_COMMAND),
    redo: () => command(REDO_COMMAND),
  };
}

test('MDXEditor uses the external baseline as its instance key and initial Markdown', () => {
  let attributes;
  function visitEditor(node) {
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(ast) === 'MDXEditor') {
      attributes = new Map(node.attributes.properties.filter(ts.isJsxAttribute)
        .map((attribute) => [attribute.name.getText(ast), attribute.initializer?.getText(ast)]));
    }
    ts.forEachChild(node, visitEditor);
  }
  visitEditor(ast);
  assert.equal(attributes.get('key'), '{baseline.revision}');
  assert.equal(attributes.get('markdown'), '{baseline.markdown}');
  assert.equal(attributes.get('autoFocus'), '{baseline.focused}');
});

test('Undo after different external Markdown cannot autosave the replaced local document', async (t) => {
  const f = await createHistoryFixture(t);
  await f.edit('User edit one.');
  await f.edit('User edit two.');
  assert.deepEqual(f.writes, ['User edit one.\n', 'User edit two.\n']);
  const previous = f.editor;
  await f.refresh('Agent replacement.\n');
  assert.notEqual(f.editor, previous);
  assert.equal(f.revision, 1);
  assert.equal(f.output, 'Agent replacement.');
  assert.equal(f.coordinator.get(f.path).status, 'saved');
  assert.equal(f.writes.length, 2, 'External synchronization must not save');

  await f.undo();
  await f.redo();
  assert.equal(f.disk, 'Agent replacement.\n', 'Undo must not write the replaced local document back to disk');
  assert.equal(f.coordinator.get(f.path).text, 'Agent replacement.\n');
  assert.equal(f.writes.length, 2);

  await f.edit('New user edit.');
  await f.undo();
  assert.equal(f.disk, 'Agent replacement.\n', 'New edits must undo to the external baseline');
  await f.redo();
  assert.equal(f.disk, 'New user edit.\n');
});

test('same-content refresh and local draft echoes retain Markdown Undo and Redo', async (t) => {
  const f = await createHistoryFixture(t);
  const original = f.editor;
  await f.edit('User edit one.');
  await f.edit('User edit two.');
  await f.refresh();
  assert.equal(f.editor, original);
  assert.equal(f.revision, 0);
  assert.equal(f.writes.length, 2);
  await f.undo();
  assert.equal(f.disk, 'User edit one.\n');
  await f.refresh();
  await f.redo();
  assert.equal(f.disk, 'User edit two.\n');
  assert.equal(f.editor, original);
  assert.equal(f.revision, 0);
});

test('different external Markdown clears a pending Redo from the old document', async (t) => {
  const f = await createHistoryFixture(t);
  await f.edit('User edit one.');
  await f.edit('User edit two.');
  await f.undo();
  assert.equal(f.disk, 'User edit one.\n');
  const writesBefore = f.writes.length;
  await f.refresh('Agent replacement.\n');
  await f.redo();
  assert.equal(f.disk, 'Agent replacement.\n');
  assert.equal(f.writes.length, writesBefore);
});

test('programmatic synchronization does not copy unsafe output into the draft', async function () {
  const fixture = await createEditorFixture();
  fixture.syncing.current = true;
  fixture.onChange('Price: $10\n', false);
  await fixture.coordinator.flush(fixture.path);
  assert.equal(fixture.coordinator.get(fixture.path).text, 'Old paragraph.\n');
  assert.deepEqual(fixture.writes, []);
  assert.deepEqual(fixture.fallbacks, []);
});
