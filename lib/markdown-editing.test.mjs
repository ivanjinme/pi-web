import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { markdownEnvelope, restoreMarkdownEnvelope, markdownFallbackReason, isSafeMarkdownRoundTrip } from './markdown-editing.ts';
const fixtures = JSON.parse(fs.readFileSync(new URL('./fixtures/file-editors-markdown.json', import.meta.url), 'utf8'));
test('preserves BOM, CRLF/LF and trailing newlines around rich text output', () => {
  for (const original of ['\ufeff# Heading\r\n\r\nText.\r\n\r\n', '# Heading\n\nText.\n', 'Text.', '']) {
    const envelope = markdownEnvelope(original);
    assert.equal(restoreMarkdownEnvelope(envelope.body, original), original);
  }
  assert.equal(restoreMarkdownEnvelope('New.\n', '\ufeffOld.\r\n\r\n'), '\ufeffNew.\r\n\r\n');
});
test('rejects unsafe syntax outside fenced code without misclassifying ordinary URLs', () => {
  const names = new Map(fixtures.map((f) => [f.name, f.markdown]));
  assert.equal(markdownFallbackReason(names.get('basic'), 'basic.md'), null);
  assert.equal(markdownFallbackReason('See [web](https://example.com).', 'a.md'), null);
  assert.equal(markdownFallbackReason('```ts\nconst price = "$1";\n```', 'a.md'), null);
  for (const name of ['math', 'html', 'unknown-tag', 'frontmatter', 'resources', 'code']) assert.ok(markdownFallbackReason(names.get(name), `${name}.md`), name);
  assert.ok(markdownFallbackReason('export const x = 1;', 'a.mdx'));
  assert.ok(markdownFallbackReason('[local](C:\\test\\a.md)', 'a.md'));
  assert.equal(markdownFallbackReason('![image](./image.png)\n\n[local](./a.md)', 'a.md'), null);
});
test('round-trip allows explicit formatting only and detects missing nodes/resources/code', () => {
  assert.equal(isSafeMarkdownRoundTrip('Heading\n=======\n\n\nText.\n', '# Heading\n\nText.'), true);
  assert.equal(isSafeMarkdownRoundTrip('- first\n  - nested', '* first\n  * nested'), true);
  assert.equal(isSafeMarkdownRoundTrip('Hello.\n\nWorld.', 'Hello.\nWorld.'), false);
  for (const original of ['![image](./image.png)', '[local](./a.md)', '```ts\nconst x = 1;\n```', '- first\n  - nested']) {
    assert.equal(isSafeMarkdownRoundTrip(original, original), true);
    assert.equal(isSafeMarkdownRoundTrip(original, ''), false);
  }
  assert.equal(isSafeMarkdownRoundTrip('`a\\[b]`', '`a[b]`'), false);
  assert.equal(isSafeMarkdownRoundTrip('- first\n  - nested', '- first\n- nested'), false);
  assert.equal(isSafeMarkdownRoundTrip('```ts\n\ntext\n```', '```ts\ntext\n```'), false);
});
