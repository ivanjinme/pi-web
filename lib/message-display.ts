import type { AssistantContentBlock, AssistantMessage, TextContent, ThinkingContent, ToolCallContent } from "./types";

export type TextPhase = "commentary" | "final_answer";

export function getTextPhase(block: TextContent): TextPhase | undefined {
  if (!block.textSignature?.startsWith("{")) return undefined;
  try {
    const signature = JSON.parse(block.textSignature) as { v?: unknown; phase?: unknown };
    if (signature.v === 1 && (signature.phase === "commentary" || signature.phase === "final_answer")) {
      return signature.phase;
    }
  } catch {
    // Legacy and malformed signatures carry no display phase.
  }
  return undefined;
}

interface DisplayOptions {
  isStreaming?: boolean;
}

export function isEmptyThinkingBlock(block: AssistantContentBlock, options: DisplayOptions = {}): block is ThinkingContent {
  return block.type === "thinking" && !block.deferred && !options.isStreaming && block.thinking.trim() === "";
}

export function getDisplayableAssistantBlocks(
  message: AssistantMessage,
  options: DisplayOptions = {},
): AssistantContentBlock[] {
  return (message.content ?? []).filter((block) => !isEmptyThinkingBlock(block, options));
}

function isFinalAnswerBlock(block: AssistantContentBlock): boolean {
  if (block.type === "text") return getTextPhase(block) !== "commentary";
  return block.type === "image";
}

export function splitFinalAssistantBlocks(
  message: AssistantMessage,
  options: DisplayOptions = {},
): { answerBlocks: AssistantContentBlock[]; processBlocks: AssistantContentBlock[] } {
  const blocks = getDisplayableAssistantBlocks(message, options);
  const lastProcessIndex = blocks.findLastIndex((block) => !isFinalAnswerBlock(block));
  if (lastProcessIndex === -1) {
    return { answerBlocks: blocks, processBlocks: [] };
  }
  return {
    answerBlocks: blocks.slice(lastProcessIndex + 1),
    processBlocks: blocks.slice(0, lastProcessIndex + 1),
  };
}

export function countToolCallBlocks(blocks: AssistantContentBlock[]): number {
  return blocks.filter((block): block is ToolCallContent => block.type === "toolCall").length;
}

/**
 * Error text for a failed model call, or null for successful/aborted messages.
 *
 * Every provider funnels stream failures (usage limits, overloads, auth) into
 * an assistant message with stopReason "error" + errorMessage; content may be
 * empty (e.g. codex usage-limit errors persist `content: []`). The fallback
 * keeps the error box visible when a provider omits the message text.
 */
export function getAssistantErrorMessage(message: AssistantMessage): string | null {
  if (message.stopReason !== "error") return null;
  const raw = typeof message.errorMessage === "string" ? message.errorMessage.trim() : "";
  return raw.length > 0 ? raw : "Model request failed.";
}
