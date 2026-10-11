export interface MarkdownEnvelope { bom: string; newline: string; trailing: string; body: string }
export function markdownEnvelope(text: string): MarkdownEnvelope {
  const bom = text.startsWith("\ufeff") ? "\ufeff" : "";
  const withoutBom = text.slice(bom.length);
  const trailing = withoutBom.match(/(?:\r?\n)*$/)?.[0] ?? "";
  return { bom, newline: withoutBom.includes("\r\n") ? "\r\n" : "\n", trailing,
    body: withoutBom.slice(0, withoutBom.length - trailing.length).replace(/\r\n/g, "\n") };
}
export function restoreMarkdownEnvelope(markdown: string, original: string): string {
  const envelope = markdownEnvelope(original);
  return envelope.bom + markdown.replace(/(?:\r?\n)*$/, "").replace(/\r?\n/g, envelope.newline) + envelope.trailing;
}

// 扫描块边界后保守拒绝已知有损语法；另需逐文件 round-trip 检查，不能只靠解析报错。
export function markdownFallbackReason(text: string, filePath: string): string | null {
  if (/\.mdx$/i.test(filePath)) return "MDX";
  if (/\r(?!\n)/.test(text) || (text.includes("\r\n") && text.replace(/\r\n/g, "").includes("\n"))) return "Mixed / CR line endings";
  const body = markdownEnvelope(text).body;
  let fence: { marker: string; size: number } | null = null;
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const open = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (open) {
      if (fence) {
        if (open[1][0] === fence.marker && open[1].length >= fence.size && !open[2].trim()) fence = null;
        continue;
      }
      const info = open[2].trim();
      if (/^mermaid\b/i.test(info)) return "Mermaid";
      if (/\s/.test(info)) return "Code fence metadata";
      fence = { marker: open[1][0], size: open[1].length }; continue;
    }
    if (fence) continue;
    if (i === 0 && /^---\s*$/.test(line)) return "Frontmatter";
    if (/^ {4}|^\t/.test(line)) return "Indented Markdown";
    if (/^\s*(?:import|export)\s/.test(line)) return "MDX";
    if (/\b(?:javascript|vbscript|data):/i.test(line)) return "Unsafe URL";
    // 未解析的 inline code 也采取保守策略，宁可只读，不误判为无损。
    if (/<[A-Za-z!/?]|\{[^}]*\}/.test(line)) return "HTML / JSX";
    if (/\$|\\[()[\]]/.test(line)) return "Math / LaTeX";
    if (/^ {0,3}\[[^\]]+\]:|!?\[[^\]]*\]\s*\[[^\]]*\]/.test(line)) return "Reference links";
    if (/\]\(\s*(?:[A-Za-z]:[\\/]|file:)/i.test(line)) return "Windows / file links";
  }
  if (fence) return "Unclosed code fence";
  return null;
}

function comparisonTokens(text: string): string {
  const lines = markdownEnvelope(text).body.split("\n");
  const tokens: string[] = [];
  let fence: { marker: string; size: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fenceMatch) {
      if (!fence) { fence = { marker: fenceMatch[1][0], size: fenceMatch[1].length }; tokens.push(`FENCE:${fenceMatch[2].trim()}`); }
      else if (fenceMatch[1][0] === fence.marker && fenceMatch[1].length >= fence.size && !fenceMatch[2].trim()) { fence = null; tokens.push("END-FENCE"); }
      else tokens.push(`CODE:${line}`);
      continue;
    }
    if (fence) { tokens.push(`CODE:${line}`); continue; }
    if (!line.trim()) {
      const previous = lines[i - 1] ?? "";
      let nextIndex = i + 1;
      while (nextIndex < lines.length && !lines[nextIndex].trim()) nextIndex++;
      const next = lines[nextIndex] ?? "";
      const blockStart = (value: string) => /^(?: {0,3}(?:#|>|[-*+] |\d+[.)] |`{3,}|~{3,}|\||[-*_]{3,}))/.test(value);
      if (tokens.at(-1)?.startsWith("TEXT:") && previous.trim() && next.trim() && !blockStart(previous) && !blockStart(next)) tokens.push("PARAGRAPH-BREAK");
      continue;
    }
    if (i + 1 < lines.length && /^ {0,3}(?:=+|-+)\s*$/.test(lines[i + 1]) && line.trim()) {
      tokens.push(`HEADING:${lines[i + 1].trim()[0] === "=" ? 1 : 2}:${line.trim()}`); i++; continue;
    }
    const heading = line.match(/^ {0,3}(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/);
    if (heading) { tokens.push(`HEADING:${heading[1].length}:${heading[2]}`); continue; }
    if (/^ {0,3}(?:\*\s*){3,}$|^ {0,3}(?:-\s*){3,}$|^ {0,3}(?:_\s*){3,}$/.test(line)) { tokens.push("RULE"); continue; }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      tokens.push("TABLE:" + line.trim().split("|").map((cell) => /^\s*:?-+:?\s*$/.test(cell) ? cell.trim().replace(/-+/g, "-") : cell.trim()).join("|"));
      continue;
    }
    // 保留缩进层级及硬换行，不把语义差异当成纯格式差异。
    const normalized = line.replace(/^(\s*)[*+] /, "$1- ").split(/(`+[^`]*`+)/)
      .map((part, index) => index % 2 ? part : part.replace(/\\([\[\]=])/g, "$1")).join("");
    tokens.push(`TEXT:${normalized}`);
  }
  return JSON.stringify(tokens);
}
export function isSafeMarkdownRoundTrip(original: string, serialized: string): boolean {
  return comparisonTokens(original) === comparisonTokens(serialized);
}
