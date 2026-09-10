const TRAILING_FILE_SECTIONS_RE = /(?:\r?\n){2,}((?:[ \t]*<(?:read-files|modified-files)>[ \t]*\r?\n[\s\S]*?\r?\n[ \t]*<\/(?:read-files|modified-files)>[ \t]*(?:\r?\n)?)+)\s*$/;

// 压缩摘要正文末尾可能附带 pi 生成的 <read-files>/<modified-files> 标签，
// 仅用于上下文追踪，展示时需剥离，避免把标签当正文渲染。
export function compactionSummaryBody(summary: string): string {
  return summary.replace(TRAILING_FILE_SECTIONS_RE, "").trim();
}
