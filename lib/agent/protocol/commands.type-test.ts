import { sendAgentCommand } from "../../agent-client";
import type { ToolEntry } from "../../tool-presets";
import type { AgentState, QueuedMessages } from "./commands";

declare function expectType<T>(value: T): void;

// 仅由 tsc 检查，不执行 HTTP 请求。
export async function checkCommandTypes() {
  expectType<ToolEntry[]>(await sendAgentCommand("session", { type: "get_tools" }));
  expectType<AgentState>(await sendAgentCommand("session", { type: "get_state" }));
  expectType<QueuedMessages>(await sendAgentCommand("session", { type: "clear_queue" }));
  expectType<null>(await sendAgentCommand("session", { type: "abort" }));

  const fork = await sendAgentCommand("session", { type: "fork", entryId: "entry" });
  if (!fork.cancelled) expectType<string>(fork.newSessionId);

  // @ts-expect-error command 名拼错必须在编译时失败。
  await sendAgentCommand("session", { type: "get_tool" });
  // @ts-expect-error prompt 必须携带 message。
  await sendAgentCommand("session", { type: "prompt" });
  // @ts-expect-error set_model 必须同时携带 provider 和 modelId。
  await sendAgentCommand("session", { type: "set_model", provider: "test" });
  // @ts-expect-error 工具设置必须提供 preset 或明确的工具列表。
  await sendAgentCommand("session", { type: "set_tools" });
  // @ts-expect-error extension response 必须提供响应值或取消标志。
  await sendAgentCommand("session", { type: "extension_ui_response", id: "dialog" });
  // @ts-expect-error 调用方不能自行指定一个无关的返回类型。
  await sendAgentCommand<ToolEntry[]>("session", { type: "abort" });
  // @ts-expect-error get_tools 的结果不能当成状态快照。
  expectType<AgentState>(await sendAgentCommand("session", { type: "get_tools" }));
}
