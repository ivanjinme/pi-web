import assert from "node:assert/strict";
import { test } from "node:test";
import { createRuntimeEnvironment } from "./runtime.mjs";

const root = "C:\\Weclio\\resources\\runtime\\win-x64";

test("bundled tools are appended without changing the parent environment or user configuration", () => {
  const env = { Path: "C:\\Node;C:\\ExistingGit\\cmd", PI_CODING_AGENT_DIR: "C:\\agent", HOME: "C:\\user" };
  const before = { ...env };
  const result = createRuntimeEnvironment(root, env, "win32");
  assert.deepEqual(env, before);
  assert.equal(result.Path, undefined);
  assert.deepEqual(result.PATH.split(";"), ["C:\\Node", "C:\\ExistingGit\\cmd", `${root}\\tools`]);
  assert.equal(result.PI_CODING_AGENT_DIR, env.PI_CODING_AGENT_DIR);
  assert.equal(result.HOME, env.HOME);
  assert.equal(result.WECLIO_BASH_PATH, undefined);
});

test("Windows PATH variants and duplicate entries are merged into one key", () => {
  const result = createRuntimeEnvironment(root, { Path: "C:\\Node;", PATH: "c:\\node;C:\\Windows\\System32" }, "win32");
  assert.deepEqual(Object.keys(result), ["PATH"]);
  assert.deepEqual(result.PATH.split(";").slice(0, 2), ["C:\\Node", "C:\\Windows\\System32"]);
});

test("non-Windows development keeps its existing environment", () => {
  const env = { PATH: "/usr/bin:/bin" };
  assert.deepEqual(createRuntimeEnvironment(root, env, "linux"), env);
});
