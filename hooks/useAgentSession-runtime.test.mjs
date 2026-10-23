import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";

// 保留 hook 状态和 ref，仅替换 React 调度与网络边界；执行真实的草稿操作链。
function createHookState() {
  const cells = [];
  let cursor = 0;
  const useState = (initial) => {
    const index = cursor++;
    if (!(index in cells)) cells[index] = typeof initial === "function" ? initial() : initial;
    return [cells[index], (value) => {
      cells[index] = typeof value === "function" ? value(cells[index]) : value;
    }];
  };
  return {
    reset() { cursor = 0; },
    react: {
      useState,
      useRef(initial) { return useState(() => ({ current: initial }))[0]; },
      useReducer(_reducer, initial) { return useState(initial); },
      useCallback(fn) { return fn; },
      useMemo(fn) { return fn(); },
      useEffect() {},
    },
  };
}

test("autocomplete-created drafts preserve thinking through first send and subsequent model changes", async (t) => {
  const hooks = createHookState();
  const commands = [];
  let runtimeThinking = "high";
  let creationCount = 0;
  const jiti = createJiti(import.meta.url, {
    alias: { "@": fileURLToPath(new URL("../", import.meta.url)) },
    virtualModules: {
      react: hooks.react,
      "@/lib/agent-client": {
        async sendAgentCommand(_sid, command) {
          commands.push(command);
          // SDK setModel() 会重新应用保存的默认推理档位。
          if (command.type === "set_model") runtimeThinking = "high";
          if (command.type === "set_thinking_level") runtimeThinking = command.level;
          if (command.type === "prompt") assert.equal(runtimeThinking, "medium");
          return command.type === "get_commands" ? { commands: [] } : null;
        },
      },
    },
  });
  const { useAgentSession: runSessionHook } = await jiti.import("./useAgentSession.ts");
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "/api/agent/new");
    const body = JSON.parse(options.body);
    assert.equal(body.thinkingLevel, "medium");
    assert.equal(body.modelId, "first-model");
    runtimeThinking = body.thinkingLevel;
    creationCount++;
    return Response.json({ sessionId: "draft-session" });
  });
  class EventSourceStub {
    static OPEN = 1;
    readyState = 1;
    constructor() {
      queueMicrotask(() => this.onmessage({ data: JSON.stringify({ type: "connected" }) }));
    }
    close() {}
  }
  const previousEventSource = globalThis.EventSource;
  globalThis.EventSource = EventSourceStub;
  t.after(() => {
    if (previousEventSource === undefined) delete globalThis.EventSource;
    else globalThis.EventSource = previousEventSource;
  });
  const renderDraft = () => {
    hooks.reset();
    return runSessionHook({ session: null, newSessionCwd: process.cwd(), resolveNewSessionCwd: async () => process.cwd() });
  };

  let draft = renderDraft();
  await draft.handleModelChange("provider", "first-model");
  draft = renderDraft();
  await draft.loadSlashCommands();
  draft = renderDraft();
  assert.equal(await draft.handleSend("Hello"), true);
  assert.equal(runtimeThinking, "medium");
  assert.equal(creationCount, 1);
  assert.deepEqual(commands.map((command) => command.type), ["get_commands", "set_model", "set_thinking_level", "prompt"]);

  // 换模型后仍须重新应用草稿选择，不能被 SDK 的 high 默认值覆盖。
  await draft.handleModelChange("provider", "second-model");
  assert.equal(runtimeThinking, "medium");
  assert.deepEqual(commands.slice(-2).map((command) => command.type), ["set_model", "set_thinking_level"]);
});
