export interface SourceLineRange { startLine: number; endLine: number }
export interface SourceTextChange { from: number; to: number; insert: string }

// CodeMirror 的文档位置把 CRLF 视为一个字符；写回时只改选中区间，保留其余原始换行。
export function applySourceChanges(raw: string, changes: SourceTextChange[], newline: string): string {
  let rawOffset = 0, docOffset = 0, copiedThrough = 0;
  const chunks: string[] = [];
  const advance = (position: number) => {
    while (docOffset < position && rawOffset < raw.length) {
      rawOffset += raw[rawOffset] === "\r" && raw[rawOffset + 1] === "\n" ? 2 : 1;
      docOffset++;
    }
    return rawOffset;
  };
  for (const change of changes) {
    const from = advance(change.from), to = advance(change.to);
    chunks.push(raw.slice(copiedThrough, from), change.insert.replace(/\n/g, newline));
    copiedThrough = to;
  }
  chunks.push(raw.slice(copiedThrough));
  return chunks.join("");
}
export function sourceLineRange(doc: { lineAt: (offset: number) => { number: number; from: number; to: number } }, from: number, to: number): SourceLineRange | null {
  if (from === to) return null;
  const start = doc.lineAt(from), end = doc.lineAt(to);
  const startLine = start.number + (from === start.to && end.number > start.number ? 1 : 0);
  const endLine = end.number - (to === end.from && end.number > start.number ? 1 : 0);
  return startLine <= endLine ? { startLine, endLine } : null;
}
