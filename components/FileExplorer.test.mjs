import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./FileExplorer.tsx", import.meta.url), "utf8");

test("active files receive a persistent Explorer selection treatment", () => {
  assert.match(source, /selectedFilePath\?: string \| null;/);
  assert.match(source, /const normalizedSelectedFilePath = selectedFilePath \? normalizeFilePathSlashes\(selectedFilePath\) : null;/);
  assert.match(source, /const selected = !node\.isDir && normalizedPath === selectedFilePath;/);
  assert.match(source, /background: selected \|\| hovered \? "var\(--bg-hover\)" : "transparent"/);
  assert.match(source, /selectedFilePath=\{normalizedSelectedFilePath\}/);
  assert.doesNotMatch(source, /\{t\("files\.mention"\)\}/);
});
