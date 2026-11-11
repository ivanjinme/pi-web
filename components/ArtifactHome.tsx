"use client";

import { useI18n } from "@/hooks/useI18n";
import { ArtifactIcon } from "./ArtifactIcon";

export function ArtifactHome({ onOpen }: { onOpen: (kind: "files" | "changes") => void }) {
  const { locale } = useI18n();
  const zh = locale === "zh-CN";
  const entries = [
    { kind: "files", title: "Files", description: zh ? "浏览、预览和编辑工作区文件" : "Browse, preview and edit workspace files" },
    { kind: "changes", title: "Changes", description: zh ? "按对话轮次查看文件修改" : "Review file changes by conversation turn" },
    { kind: "terminal", title: "Terminal", description: zh ? "在工作区运行命令" : "Run commands in the workspace" },
    { kind: "browser", title: "Browser", description: zh ? "浏览网页与本地预览" : "Browse pages and local previews" },
  ] as const;

  return (
    <div className="artifact-home">
      <span className="artifact-home-hero"><ArtifactIcon kind="home" size={56} /></span>
      {entries.map(({ kind, title, description }) => {
        const available = kind === "files" || kind === "changes";
        return (
          <button key={kind} type="button" className="artifact-home-entry" disabled={!available} onClick={() => { if (available) onOpen(kind); }}>
            <span className="artifact-home-icon"><ArtifactIcon kind={kind} size={24} /></span>
            <span className="artifact-home-text">
              <span className="artifact-home-title">{title}</span>
              <span className="artifact-home-description">{description}</span>
            </span>
            {!available && <span className="artifact-home-soon">{zh ? "即将支持" : "Coming soon"}</span>}
          </button>
        );
      })}
    </div>
  );
}
