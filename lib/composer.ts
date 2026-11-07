import { buildAtMentionText } from "./file-fuzzy";

export type ComposerPart =
  | { type: "text"; text: string }
  | { type: "skill"; name: string }
  | { type: "file"; path: string };

export function textParts(text: string): ComposerPart[] {
  return text ? [{ type: "text", text }] : [];
}

export function composerPartText(part: ComposerPart): string {
  return part.type === "text" ? part.text : part.type === "skill" ? part.name : part.path;
}

export function composerText(parts: ComposerPart[]): string {
  return parts.map(composerPartText).join("");
}

export function serializeComposerPart(part: ComposerPart): string {
  if (part.type === "skill") return `/skill:${part.name}`;
  if (part.type === "file") return buildAtMentionText(part.path, false).trimEnd();
  return part.text;
}

export function serializeComposer(parts: ComposerPart[]): string {
  return parts.map(serializeComposerPart).join("");
}

// 补全不扫描标签，但偏移与编辑器的 UTF-16 选区保持一致。
export function completionText(parts: ComposerPart[]): string {
  return parts.map((part) => part.type === "text" ? part.text : "\ufffc".repeat(composerPartText(part).length)).join("");
}

export function extractSlashToken(text: string, cursor: number): { start: number; end: number; query: string } | null {
  const match = /(?:^|[ \n])(\/[^\s/]*)$/.exec(text.slice(0, cursor));
  return match ? { start: cursor - match[1].length, end: cursor, query: match[1].slice(1).toLowerCase() } : null;
}

// 队列和输入历史来自 SDK 的字符串；将已展开的 skill 还原为编辑节点。
export function restoreComposerText(text: string): ComposerPart[] {
  const parts: ComposerPart[] = [];
  const pattern = /<skill name="([^"]+)" location="[^"]*">[\s\S]*?<\/skill>/g;
  let offset = 0;
  for (const match of text.matchAll(pattern)) {
    parts.push(...textParts(text.slice(offset, match.index)), { type: "skill", name: match[1] });
    offset = match.index + match[0].length;
  }
  parts.push(...textParts(text.slice(offset)));
  return parts;
}
