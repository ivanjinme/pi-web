import {
  $createParagraphNode, $createTextNode, $getRoot, $getSelection,
  $isElementNode, $isRangeSelection, $isTextNode, type LexicalNode,
} from "lexical";
import { composerPartText, textParts, type ComposerPart } from "@/lib/composer";
import { $createSkillNode, SkillNode } from "./SkillNode";
import { $createFileNode, FileNode } from "./FileNode";

export function $readDocument() {
  const parts: ComposerPart[] = [];
  const positions = new Map<string, { start: number; end: number; children?: number[] }>();
  let offset = 0;
  const visit = (node: LexicalNode) => {
    const start = offset;
    if ($isElementNode(node)) {
      const children = [offset];
      for (const child of node.getChildren()) {
        visit(child);
        children.push(offset);
      }
      positions.set(node.getKey(), { start, end: offset, children });
    } else {
      const text = node.getTextContent();
      const part: ComposerPart = node instanceof SkillNode
        ? { type: "skill", name: node.getName() }
        : node instanceof FileNode
          ? { type: "file", path: node.getPath() }
          : { type: "text", text };
      const previous = parts.at(-1);
      if (part.type === "text" && previous?.type === "text") previous.text += text;
      else parts.push(part);
      offset += text.length;
      positions.set(node.getKey(), { start, end: offset });
    }
  };
  const boundaries = [0];
  for (const [index, node] of $getRoot().getChildren().entries()) {
    if (index > 0) {
      parts.push({ type: "text", text: "\n" });
      offset++;
    }
    visit(node);
    boundaries.push(offset);
  }
  positions.set($getRoot().getKey(), { start: 0, end: offset, children: boundaries });
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return { parts, start: offset, end: offset };
  const offsetOf = (point: typeof selection.anchor) => {
    const position = positions.get(point.key)!;
    return point.type === "text" ? position.start + point.offset : position.children![point.offset];
  };
  const anchor = offsetOf(selection.anchor);
  const focus = offsetOf(selection.focus);
  return { parts, start: Math.min(anchor, focus), end: Math.max(anchor, focus) };
}

export function $replaceDocument(parts: ComposerPart[]) {
  const root = $getRoot();
  root.clear();
  let paragraph = $createParagraphNode();
  root.append(paragraph);
  for (const part of parts) {
    if (part.type !== "text") {
      paragraph.append(part.type === "skill" ? $createSkillNode(part.name) : $createFileNode(part.path));
      continue;
    }
    for (const [index, line] of part.text.split("\n").entries()) {
      if (index > 0) {
        paragraph = $createParagraphNode();
        root.append(paragraph);
      }
      if (line) paragraph.append($createTextNode(line));
    }
  }
}

function $selectOffset(offset: number) {
  let remaining = offset;
  for (const [index, paragraph] of $getRoot().getChildren().entries()) {
    if (index > 0) remaining--;
    if (!$isElementNode(paragraph)) continue;
    if (remaining <= 0) { paragraph.selectStart(); return; }
    for (const node of paragraph.getChildren()) {
      const size = node.getTextContentSize();
      if (remaining <= size) {
        if ($isTextNode(node)) node.select(remaining, remaining);
        else paragraph.select(node.getIndexWithinParent() + 1, node.getIndexWithinParent() + 1);
        return;
      }
      remaining -= size;
    }
  }
  $getRoot().selectEnd();
}

export function $selectRange(start: number, end = start) {
  $selectOffset(end);
  const last = $getSelection();
  if (!$isRangeSelection(last)) return;
  const point = { key: last.anchor.key, offset: last.anchor.offset, type: last.anchor.type };
  $selectOffset(start);
  const selection = $getSelection();
  if ($isRangeSelection(selection)) selection.focus.set(point.key, point.offset, point.type);
}

export function $insertParts(parts: ComposerPart[]) {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return;
  selection.removeText();
  for (const part of parts) {
    if (part.type === "text") selection.insertRawText(part.text);
    else selection.insertNodes([part.type === "skill" ? $createSkillNode(part.name) : $createFileNode(part.path)]);
  }
}

export function selectedParts(parts: ComposerPart[], start: number, end: number): ComposerPart[] {
  let offset = 0;
  return parts.flatMap((part) => {
    const length = composerPartText(part).length;
    const from = Math.max(0, start - offset);
    const to = Math.min(length, end - offset);
    offset += length;
    if (from >= to) return [];
    return part.type === "text" ? textParts(part.text.slice(from, to)) : [part];
  });
}
