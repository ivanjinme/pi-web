import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const {
  getPresetFromTools,
  getToolNamesForPreset,
  isToolPreset,
} = await jiti.import("./tool-presets.ts");

const builtinToolNames = ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls", "future_builtin"];
const shells = (bash, powershell) => ({ bash, powershell });

test("default uses the preferred available shell", () => {
  assert.deepEqual(getToolNamesForPreset("default", shells(true, true), builtinToolNames), ["read", "bash", "edit", "write"]);
  assert.deepEqual(getToolNamesForPreset("default", shells(false, true), builtinToolNames), ["read", "powershell", "edit", "write"]);
  assert.deepEqual(getToolNamesForPreset("default", shells(false, false), builtinToolNames), ["read", "edit", "write"]);
});

test("full includes future Pi built-ins and only available shells", () => {
  assert.deepEqual(getToolNamesForPreset("full", shells(true, true), builtinToolNames), builtinToolNames);
  assert.deepEqual(getToolNamesForPreset("full", shells(true, false), builtinToolNames), builtinToolNames.filter((name) => name !== "powershell"));
  assert.deepEqual(getToolNamesForPreset("full", shells(false, true), builtinToolNames), builtinToolNames.filter((name) => name !== "bash"));
  assert.deepEqual(getToolNamesForPreset("full", shells(false, false), builtinToolNames), builtinToolNames.filter((name) => name !== "bash" && name !== "powershell"));
});

test("preset inference uses Pi source metadata and ignores extension tools", () => {
  const entries = (active) => [
    ...builtinToolNames.map((name) => ({ name, description: "", source: "builtin", active: active.includes(name) })),
    { name: "extension_tool", description: "", source: "extension", active: active.includes("extension_tool") },
  ];

  assert.equal(getPresetFromTools(entries([])), "none");
  assert.equal(getPresetFromTools(entries(["extension_tool"])), "default");
  assert.equal(getPresetFromTools(entries(["read", "powershell", "edit", "write", "extension_tool"])), "default");
  assert.equal(getPresetFromTools(entries(builtinToolNames.filter((name) => name !== "powershell"))), "full");
});

test("tool preset validation accepts only supported values", () => {
  assert.equal(isToolPreset("none"), true);
  assert.equal(isToolPreset("default"), true);
  assert.equal(isToolPreset("full"), true);
  assert.equal(isToolPreset("read"), false);
});
