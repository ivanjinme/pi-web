import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createJiti } from 'jiti';
const { writeExistingText, isEditableFile, readTextBody, decodeEditableText } = await createJiti(import.meta.url).import('./file-write.ts');
const bytes = (text) => new TextEncoder().encode(text);
function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'file-write-'));
  const root = path.join(base, 'root'); fs.mkdirSync(root);
  const file = path.join(root, 'test.txt'); fs.writeFileSync(file, 'old');
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { base, root, file, roots: new Set([root]) };
}
function status(n) { return (error) => error.status === n; }
test('writes Unicode, BOM, CRLF, trailing newlines and empty text exactly', (t) => {
  const { file, roots } = fixture(t);
  for (const text of ['\ufeff中文\r\n\r\n', 'hello\n', '']) {
    assert.equal(writeExistingText(file, roots, bytes(text)), bytes(text).length);
    assert.equal(fs.readFileSync(file, 'utf8'), text);
  }
  assert.equal(isEditableFile(file, roots), true);
});
test('rejects external references, missing files and directories without creating files', (t) => {
  const { base, root, roots } = fixture(t);
  const external = path.join(base, 'external.txt'); fs.writeFileSync(external, 'external');
  assert.throws(() => writeExistingText(external, roots, bytes('x')), status(403));
  const missing = path.join(root, 'deleted.txt');
  assert.throws(() => writeExistingText(missing, roots, bytes('x')), status(404));
  assert.equal(fs.existsSync(missing), false);
  assert.throws(() => writeExistingText(path.join(root,'bad')+'\0.txt',roots,bytes('x')),status(400));
  assert.throws(() => writeExistingText(root, roots, bytes('x')), status(400));
  assert.equal(isEditableFile(external, roots), false);
});
test('rejects binary targets, invalid UTF-8 and recognized read-only types', (t) => {
  const { file, root, roots } = fixture(t);
  for (const content of [Buffer.from([0, 1, 2]), Buffer.from([0xc0, 0xaf])]) {
    fs.writeFileSync(file, content);
    assert.equal(isEditableFile(file, roots), false);
    assert.throws(() => writeExistingText(file, roots, bytes('x')), status(415));
    assert.deepEqual(fs.readFileSync(file), content);
  }
  assert.throws(() => decodeEditableText(bytes('text'), path.join(root, 'image.svg')), status(415));
  assert.throws(() => decodeEditableText(new Uint8Array([0xff]), file), status(415));
});
test('enforces real Unicode byte limits on target and request streams without Content-Length', async (t) => {
  const { file, roots } = fixture(t);
  const large = bytes('中'.repeat(90000));
  assert.throws(() => writeExistingText(file, roots, large), status(413));
  const request = new Request('http://localhost', { method: 'PUT', headers: { 'content-type': 'text/plain; charset=utf-8' }, body: new ReadableStream({ start(c) { c.enqueue(large); c.close(); } }), duplex: 'half' });
  await assert.rejects(readTextBody(request), status(413));
  fs.writeFileSync(file, large);
  assert.throws(() => writeExistingText(file, roots, bytes('x')), status(413));
  assert.equal(isEditableFile(file, roots), false);
});
test('symlink escape cannot authorize a write', (t) => {
  const { base, root, roots } = fixture(t);
  const outside = path.join(base, 'outside'); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
  const link = path.join(root, 'link');
  fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => writeExistingText(path.join(link, 'secret.txt'), roots, bytes('x')), status(403));
  assert.equal(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'), 'secret');
});
test('reads an aliased descriptor once per inspection while preserving writes', (t) => {
  const { root, file, roots } = fixture(t);
  const alias = path.join(root, 'alias.txt');
  const realpath = fs.realpathSync;
  t.mock.method(fs, 'realpathSync', (target) => realpath(target === alias ? file : target));
  const read = fs.readSync;
  const reads = t.mock.method(fs, 'readSync', (...args) => read(...args));
  assert.equal(isEditableFile(alias, roots), true);
  assert.equal(reads.mock.callCount(), 1);
  assert.equal(writeExistingText(alias, roots, bytes('new')), 3);
  assert.equal(reads.mock.callCount(), 2);
  assert.equal(fs.readFileSync(file, 'utf8'), 'new');
});
test('rejects recognized media behind a text alias without modifying its bytes', (t) => {
  const { root, roots } = fixture(t);
  const target = path.join(root, 'image.svg');
  const alias = path.join(root, 'alias.txt');
  fs.writeFileSync(target, '<svg/>');
  const realpath = fs.realpathSync;
  t.mock.method(fs, 'realpathSync', (file) => realpath(file === alias ? target : file));
  assert.equal(isEditableFile(alias, roots), false);
  assert.throws(() => writeExistingText(alias, roots, bytes('new')), status(415));
  assert.equal(fs.readFileSync(target, 'utf8'), '<svg/>');
  assert.throws(() => writeExistingText(target, roots, bytes('new')), status(415));
});
test('translates permission and disk failures without pretending a save succeeded', (t) => {
  const {file,roots}=fixture(t);
  const open=fs.openSync;
  const mocked=t.mock.method(fs,'openSync',(...args)=>{if(args[1]&fs.constants.O_RDWR)throw Object.assign(new Error('denied'),{code:'EPERM'});return open(...args);});
  assert.throws(()=>writeExistingText(file,roots,bytes('new')),status(403));
  mocked.mock.restore();
  t.mock.method(fs,'writeSync',()=>{throw Object.assign(new Error('disk full'),{code:'ENOSPC'});});
  assert.throws(()=>writeExistingText(file,roots,bytes('new')),status(500));
  assert.equal(fs.readFileSync(file,'utf8'),'old');
});
test('validates request media type, UTF-8 bytes and accepts empty bodies', async () => {
  await assert.rejects(readTextBody(new Request('http://localhost',{method:'PUT',headers:{'content-type':'application/json'},body:'"x"'})),status(415));
  const request=new Request('http://localhost',{method:'PUT',headers:{'content-type':'text/plain; charset=utf-8'},body:''});
  assert.deepEqual(await readTextBody(request),new Uint8Array());
});
