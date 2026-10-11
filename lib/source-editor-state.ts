import { Annotation, MapMode, StateEffect, StateField, type Extension } from "@codemirror/state";
import { invertedEffects } from "@codemirror/commands";
import { applySourceChanges, type SourceTextChange } from "./source-lines";

export const externalSourceText = Annotation.define<string>();
interface SourceText { text: string; newline: string }
interface SourceNewline { position: number; newline: string }

// 文档位置统一使用 LF；原始换行只属于写回文本，不参与 CodeMirror 的字符串拆分。
function sourceText(text: string): SourceText {
  return { text, newline: text.match(/\r\n|\r|\n/)?.[0] ?? "\n" };
}
function sourceNewlines(text: string): SourceNewline[] {
  const result: SourceNewline[] = [];
  let extra = 0;
  for (const match of text.matchAll(/\r\n|\r|\n/g)) {
    result.push({ position: match.index - extra, newline: match[0] });
    extra += match[0].length - 1;
  }
  return result;
}
const restoreNewline = StateEffect.define<SourceNewline>({
  map(value, mapping) {
    const position = mapping.mapPos(value.position, 1, MapMode.TrackAfter);
    return position === null ? undefined : { ...value, position };
  },
});

export const sourceTextField = StateField.define<SourceText>({
  create: () => sourceText(""),
  update(value, tr) {
    const external = tr.annotation(externalSourceText);
    if (external !== undefined) return sourceText(external);
    const restored = new Map<number, string>();
    for (const effect of tr.effects) {
      if (effect.is(restoreNewline)) restored.set(effect.value.position, effect.value.newline);
    }
    if (!tr.docChanged && !restored.size) return value;
    const changes: SourceTextChange[] = [];
    tr.changes.iterChanges((from, to, _fromB, _toB, insert) => changes.push({ from, to, insert: insert.toString() }));
    let text = applySourceChanges(value.text, changes, value.newline);
    if (restored.size) {
      let extra = 0;
      text = text.replace(/\r\n|\r|\n/g, (newline: string, offset: number) => {
        const position = offset - extra;
        extra += newline.length - 1;
        return restored.get(position) ?? newline;
      });
    }
    return { ...value, text };
  },
});

export function createSourceTextExtension(initial: string): Extension {
  return [sourceTextField.init(() => sourceText(initial)), invertedEffects.of((tr) => {
    if (!tr.docChanged && !tr.effects.some((effect) => effect.is(restoreNewline))) return [];
    const newlines = sourceNewlines(tr.startState.field(sourceTextField).text);
    const restored = new Map<number, string>();
    let index = 0;
    // 只把被删除的换行加入官方历史；合并编辑和多光标撤销仍由 CodeMirror 负责。
    tr.changes.iterChangedRanges((from, to) => {
      while (index < newlines.length && newlines[index].position < to) {
        const value = newlines[index++];
        if (value.position >= from) restored.set(value.position, value.newline);
      }
    });
    const previous = new Map(newlines.map(({ position, newline }) => [position, newline]));
    for (const effect of tr.effects) {
      if (!effect.is(restoreNewline)) continue;
      const position = tr.changes.invertedDesc.mapPos(effect.value.position, 1, MapMode.TrackAfter);
      const newline = position === null ? undefined : previous.get(position);
      if (position !== null && newline !== undefined) restored.set(position, newline);
    }
    return [...restored].map(([position, newline]) => restoreNewline.of({ position, newline }));
  })];
}
