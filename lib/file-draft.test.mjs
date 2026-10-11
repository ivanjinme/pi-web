import assert from 'node:assert/strict';
import test from 'node:test';
import { createJiti } from 'jiti';
const { FileDraftCoordinator, draftPathKey } = await createJiti(import.meta.url).import('./file-draft.ts');
const turn = () => new Promise((resolve) => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; }
function subject() {
  const writes = [];
  let disk = 'old';
  const c = new FileDraftCoordinator((path, text) => {
    const d = deferred(); writes.push({ path, text, ...d }); return d.promise.then(() => { disk=text; });
  }, async () => ({ content: disk, editable: true, language: 'text', size: disk.length }));
  return { c, writes, external: (text) => { disk=text; } };
}
test('normalizes Windows identity without conflating case-sensitive POSIX paths', () => {
  assert.equal(draftPathKey('C:\\Root\\a\\..\\FILE.txt'), 'c:/root/file.txt');
  assert.notEqual(draftPathKey('/a/B'), draftPathKey('/a/b'));
  assert.equal(draftPathKey('C:/a/../../b'),'c:/b');
  assert.equal(draftPathKey('/a/../../b'),'/b');
  assert.equal(draftPathKey('//server/share/a/../../b'),'//server/share/b');
});
test('serializes writes and restores undo while a different snapshot is in flight', async () => {
  const { c, writes } = subject(); await c.refresh('/a');
  c.edit('/a', 'new'); const saved = c.flush('/a');
  c.edit('/a', 'old'); await c.flush('/a');
  assert.equal(writes.length, 1); assert.equal(c.get('/a').status, 'saving');
  writes[0].resolve(); await turn();
  assert.equal(writes.length, 2); assert.equal(writes[1].text, 'old');
  assert.equal(c.get('/a').confirmed, 'new'); assert.equal(c.get('/a').revision,2);
  writes[1].resolve(); await saved;
  assert.equal(c.get('/a').status, 'saved'); assert.equal(c.get('/a').confirmed, 'old');
});
test('keeps path-bound drafts after closing and failures are explicitly retryable', async () => {
  const { c, writes } = subject(); await c.refresh('/a'); await c.refresh('/b');
  c.retain('/a'); c.edit('/a', 'A'); c.release('/a');
  c.edit('/b', 'B'); const b = c.flush('/b');
  writes[0].reject(new Error('disk full')); writes[1].resolve(); await turn(); await b;
  assert.equal(c.get('/a').text, 'A'); assert.equal(c.get('/a').status, 'failed');
  assert.equal(c.getProblems()[0].path, '/a');
  const retry = c.flush('/a'); assert.equal(writes[2].path, '/a');
  writes[2].resolve(); await retry; assert.equal(c.getProblems().length, 0);
});
test('debounces, max-waits and does not submit incomplete IME input', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { c, writes } = subject(); await c.refresh('/a');
  c.edit('/a', 'one'); t.mock.timers.tick(799); assert.equal(writes.length, 0);
  c.edit('/a', 'two'); t.mock.timers.tick(799); assert.equal(writes.length, 0);
  t.mock.timers.tick(1); assert.equal(writes.length, 1); writes[0].resolve(); await turn();
  c.composition('/a', true); c.edit('/a', '中文'); t.mock.timers.tick(6000); assert.equal(writes.length, 1);
  c.composition('/a', false); t.mock.timers.tick(800); assert.equal(writes.length, 2); writes[1].resolve(); await turn();
  for (let i=0;i<8;i++) { c.edit('/a', `text${i}`); t.mock.timers.tick(700); }
  assert.equal(writes.length, 3); writes[2].resolve(); await turn();
  if (writes[3]) { writes[3].resolve(); await turn(); }
});
test('ignores slow GET after input and reconciles coalesced SSE after local save', async () => {
  const slow = deferred(); let disk = 'old', first = true;
  const c = new FileDraftCoordinator(async (_path, text) => { disk = text; }, async () => {
    if (!first) return slow.promise;
    first=false; return { content: disk, language: 'text', size: 3, editable: true };
  });
  await c.refresh('/a'); const refresh = c.refresh('/a'); c.edit('/a', 'local');
  slow.resolve({ content: 'stale', language: 'text', size: 5, editable: true });
  assert.equal(await refresh, null); assert.equal(c.get('/a').text, 'local');
  // 新建正常读取实例验证被合并的外部事件在队列稳定后仍会读取。
  const s=subject(); await s.c.refresh('/a'); s.c.edit('/a', 'local');
  assert.equal(await s.c.refresh('/a'), null);
  const save=s.c.flush('/a'); s.external('agent before local'); s.writes[0].resolve(); await save; await turn();
  assert.equal(s.c.get('/a').text, 'local');
  s.external('agent last'); await s.c.refresh('/a'); assert.equal(s.c.get('/a').text, 'agent last');
  await c.flush('/a');
});
test('an ambiguous failed response cannot cancel writing an undo back to confirmed content', async () => {
  let disk='old', fail=true; const writes=[];
  const c=new FileDraftCoordinator(async (_path,text)=>{ writes.push(text); disk=text; if(fail){fail=false; throw new Error('response lost after write');} }, async()=>({content:disk,editable:true,language:'text',size:disk.length}));
  await c.refresh('/a'); c.edit('/a','new'); await c.flush('/a');
  assert.equal(c.get('/a').status,'failed'); assert.equal(disk,'new');
  c.edit('/a','old'); assert.equal(c.get('/a').status,'dirty'); await c.flush('/a');
  assert.deepEqual(writes,['new','old']); assert.equal(disk,'old');
});
test('a slow SSE read discarded after edit+undo schedules a fresh read even when now clean', async () => {
  const slow=deferred(); let reads=0;
  const c=new FileDraftCoordinator(async()=>{}, async()=>{
    reads++; if(reads===2) return slow.promise;
    return {content:reads===1?'old':'latest agent',editable:true,language:'markdown',size:3};
  });
  await c.refresh('/a'); const reading=c.refresh('/a'); c.edit('/a','new'); c.edit('/a','old');
  slow.resolve({content:'stale agent',editable:true,language:'markdown',size:3});
  await reading; await turn();
  assert.equal(reads,3); assert.equal(c.get('/a').text,'latest agent'); assert.equal(c.get('/a').language,'markdown');
});
test('shared snapshots distinguish unread files from successfully read empty files', async () => {
  const c = new FileDraftCoordinator(async () => {}, async () => ({ content: '', language: 'markdown', editable: false, size: 0 }));
  c.retain('/empty.md');
  assert.equal(c.get('/empty.md').size, null);
  await c.refresh('/empty.md');
  assert.equal(c.get('/empty.md').size, 0);
  assert.equal(c.get('/empty.md').text, '');
  assert.equal(c.get('/empty.md').language, 'markdown');
  assert.equal(c.get('/empty.md').editable, false);
  c.release('/empty.md');
});
test('shared snapshots preserve server byte size for read-only non-UTF-8 previews', async () => {
  const c = new FileDraftCoordinator(async () => {}, async () => ({ content: '\ufffd', language: 'text', editable: false, size: 1 }));
  await c.refresh('/binary');
  assert.equal(c.get('/binary').size, 1);
  assert.equal(c.get('/binary').text, '\ufffd');
});
test('failed reads do not mark an unread snapshot as loaded', async () => {
  const c = new FileDraftCoordinator(async () => {}, async () => { throw new Error('Not found'); });
  c.retain('/deleted');
  await assert.rejects(c.refresh('/deleted'), /Not found/);
  assert.equal(c.get('/deleted').size, null);
  c.release('/deleted');
});
test('opening, switching, closing and same-content SSE never save; read-only drafts reject input', async () => {
  const {c,writes}=subject(); c.retain('/a'); await c.refresh('/a'); c.release('/a');
  c.retain('/b'); await c.refresh('/b'); c.release('/b');
  await c.refresh('/a'); await c.flush('/a'); assert.equal(writes.length,0);
  const readonly=new FileDraftCoordinator(async()=>{throw Error('must not write');},async()=>({content:'external reference',language:'text',size:18,editable:false}));
  await readonly.refresh('/external'); readonly.edit('/external','overwrite'); await readonly.flush('/external');
  assert.equal(readonly.get('/external').text,'external reference');
});
