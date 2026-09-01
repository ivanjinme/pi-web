import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./[id]/export/route.ts", import.meta.url), "utf8");
const start = source.indexOf("function patchExportHtml");
const end = source.indexOf("async function exportSession", start);
assert.notEqual(start, -1, "patchExportHtml not found");
assert.notEqual(end, -1, "patchExportHtml end not found");
const patchBlock = source.slice(start, end);

test("export patch replaces recursive tree helpers with iterative traversal", () => {
  assert.match(patchBlock, /"sortChildren"[\s\S]*const stack = \[root\]/);
  assert.match(patchBlock, /"mapNodes"[\s\S]*const stack = \[\.\.\.tree\]\.reverse\(\)/);
  assert.match(patchBlock, /"markActive"[\s\S]*const stack1 = \[root\][\s\S]*const stack2 = \[\]/);
});

test("export patch fails closed when the upstream template changes", () => {
  assert.match(patchBlock, /if \(matches !== 1\)/);
  assert.match(patchBlock, /Failed to patch exported HTML/);
});
