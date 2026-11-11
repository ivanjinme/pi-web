import { parseUnifiedPatch } from "./patch";
import type { AgentMessage, ToolResultMessage } from "./types";

export type TurnChangeRow =
  | { kind: "hunk"; text: string }
  | { kind: "context" | "added" | "removed"; oldNo: number | null; newNo: number | null; text: string };

export type TurnChangeSection =
  | { toolCallId: string; kind: "edit"; patch: string; rows: TurnChangeRow[]; added: number; removed: number }
  | { toolCallId: string; kind: "write"; content: string };

export interface TurnFileChange {
  path: string;
  sections: TurnChangeSection[];
  /** 只统计有改前内容的 edit，不把 write 全文冒充新增。 */
  added: number;
  removed: number;
}

export interface TurnChange {
  id: string;
  turnIndex: number;
  files: TurnFileChange[];
  added: number;
  removed: number;
}

function patchRows(patch: string): TurnChangeRow[] {
  const rows: TurnChangeRow[] = [];
  for (const file of parseUnifiedPatch(patch) ?? []) {
    let removed: TurnChangeRow[] = [];
    let added: TurnChangeRow[] = [];
    const flush = () => {
      rows.push(...removed, ...added);
      removed = [];
      added = [];
    };
    for (const row of file.rows) {
      if (row.type === "hunk") {
        flush();
        rows.push({ kind: "hunk", text: row.text });
      } else if (row.left.type === "context") {
        flush();
        rows.push({ kind: "context", oldNo: row.left.lineNo, newNo: row.right.lineNo, text: row.left.text });
      } else {
        if (row.left.type === "removed") {
          removed.push({ kind: "removed", oldNo: row.left.lineNo, newNo: null, text: row.left.text });
        }
        if (row.right.type === "added") {
          added.push({ kind: "added", oldNo: null, newNo: row.right.lineNo, text: row.right.text });
        }
      }
    }
    flush();
  }
  return rows;
}

/** 仅从当前分支中已完成的 edit/write 记录派生，保持轮次时间顺序。 */
export function deriveTurnChanges(messages: AgentMessage[]): TurnChange[] {
  const results = new Map<string, ToolResultMessage>();
  for (const message of messages) {
    if (message.role === "toolResult") results.set(message.toolCallId, message);
  }
  const turns: TurnChange[] = [];
  let turn: TurnChange | null = null;
  let turnIndex = -1;
  for (const message of messages) {
    if (message.role === "user") {
      turnIndex++;
      turn = { id: `turn-${turnIndex}`, turnIndex, files: [], added: 0, removed: 0 };
      continue;
    }
    if (message.role !== "assistant" || !turn) continue;
    for (const call of message.content) {
      if (call.type !== "toolCall" || (call.toolName !== "edit" && call.toolName !== "write")) continue;
      const result = results.get(call.toolCallId);
      if (!result || result.isError) continue;
      const path = call.input.path;
      if (typeof path !== "string") continue;
      let section: TurnChangeSection;
      if (call.toolName === "write") {
        if (typeof call.input.content !== "string") continue;
        section = { toolCallId: call.toolCallId, kind: "write", content: call.input.content };
      } else {
        if (!Array.isArray(call.input.edits)) continue;
        const details = result.details;
        if (typeof details !== "object" || details === null || !("patch" in details) || typeof details.patch !== "string") continue;
        const rows = patchRows(details.patch);
        const added = rows.filter((row) => row.kind === "added").length;
        const removed = rows.filter((row) => row.kind === "removed").length;
        if (added + removed === 0) continue;
        section = { toolCallId: call.toolCallId, kind: "edit", patch: details.patch, rows, added, removed };
      }
      let file = turn.files.find((file) => file.path === path);
      if (!file) {
        file = { path, sections: [], added: 0, removed: 0 };
        turn.files.push(file);
      }
      file.sections.push(section);
      if (section.kind === "edit") {
        file.added += section.added;
        file.removed += section.removed;
        turn.added += section.added;
        turn.removed += section.removed;
      }
      if (turn.files.length === 1 && file.sections.length === 1) turns.push(turn);
    }
  }
  return turns;
}
