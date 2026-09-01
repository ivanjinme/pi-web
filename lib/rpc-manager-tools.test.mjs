import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");

const builtinTools = ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls", "future_builtin"];
const allTools = [
  ...builtinTools.map((name) => ({ name, description: "", sourceInfo: { source: "builtin" } })),
  { name: "extension_tool", description: "", sourceInfo: { source: "extension" } },
];

function createWrapper(shellAvailability) {
  let activeTools = [];
  const inner = {
    agent: { state: { systemPrompt: "prompt" } },
    isBashRunning: false,
    extensionRunner: { async emit() {} },
    getAllTools: () => allTools,
    setActiveToolsByName: (names) => { activeTools = names; },
    dispose() {},
  };
  return {
    wrapper: new AgentSessionWrapper(inner, shellAvailability),
    getActiveTools: () => activeTools,
  };
}

test("default excludes non-preferred shells and preserves extension tools", () => {
  const { wrapper, getActiveTools } = createWrapper({ bash: true, powershell: true });

  wrapper.setToolPreset("default");

  assert.deepEqual(getActiveTools(), ["read", "bash", "edit", "write", "extension_tool"]);
});

test("full includes runtime Pi built-ins, available shells, and extension tools", () => {
  const { wrapper, getActiveTools } = createWrapper({ bash: false, powershell: true });

  wrapper.setToolPreset("full");

  assert.deepEqual(getActiveTools(), ["read", "powershell", "edit", "write", "grep", "find", "ls", "future_builtin", "extension_tool"]);
});

test("set_tools preserves an explicit tool list instead of inferring a preset", async () => {
  const { wrapper, getActiveTools } = createWrapper({ bash: true, powershell: true });

  await wrapper.send({ type: "set_tools", toolNames: ["read"] });
  assert.deepEqual(getActiveTools(), ["read", "extension_tool"]);

  await wrapper.send({ type: "set_tools", toolNames: ["grep", "find", "ls"] });
  assert.deepEqual(getActiveTools(), ["grep", "find", "ls", "extension_tool"]);
  wrapper.destroy();
});

test("off disables built-in and extension tools", async () => {
  const { wrapper, getActiveTools } = createWrapper({ bash: true, powershell: true });

  await wrapper.send({ type: "set_tools", preset: "none" });

  assert.deepEqual(getActiveTools(), []);
  wrapper.destroy();
});
