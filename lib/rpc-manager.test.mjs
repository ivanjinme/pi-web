import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("RPC session startup preloads extension-registered providers before restoring models", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const startupSource = source.slice(source.indexOf("export async function startRpcSession"));

  assert.match(startupSource, /createAgentSessionServices\(/);
  assert.match(startupSource, /createAgentSessionFromServices\(/);
  assert.doesNotMatch(startupSource, /await createAgentSession\(/);
});

test("RPC sessions reuse one process-wide automatic shell probe", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const probeSource = source.slice(
    source.indexOf("function getShellAvailability"),
    source.indexOf("// ============================================================================\n// AgentSessionWrapper"),
  );

  assert.match(probeSource, /globalThis\.__piShellAvailability/);
  assert.match(probeSource, /getShellConfig\(\)/);
  assert.match(probeSource, /getPowerShellConfig\(\)/);
  assert.doesNotMatch(probeSource, /getShellPath/);
});

test("restoring a session does not rewrite its active tools", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const startupSource = source.slice(source.indexOf("export async function startRpcSession"));

  assert.match(startupSource, /if \(toolPreset !== undefined\)/);
  assert.match(startupSource, /else if \(toolNames !== undefined\)/);
  assert.doesNotMatch(startupSource, /getPresetFromTools/);
});

test("custom extension UI receives the fixed headless terminal facade", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const customUiSource = source.slice(
    source.indexOf("private requestExtensionCustomUi"),
    source.indexOf("private requestExtensionUi"),
  );

  assert.match(customUiSource, /createHeadlessCustomUiTui\(/);
  assert.match(customUiSource, /width,/);
});
