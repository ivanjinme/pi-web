import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

const LEVEL_ORDER: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

// 只夹取服务端确认支持的档位，避免在浏览器引入 SDK 的 provider 依赖。
export function resolveThinkingLevel(
  requested: ThinkingLevel | null,
  supported?: readonly ThinkingLevel[],
): ThinkingLevel | null {
  if (requested === null || !supported?.length) return requested;
  const index = LEVEL_ORDER.indexOf(requested);
  return supported.find((level) => LEVEL_ORDER.indexOf(level) >= index) ?? supported[supported.length - 1];
}
