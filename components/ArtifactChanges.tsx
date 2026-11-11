"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { TurnChange, TurnChangeRow, TurnChangeSection, TurnFileChange } from "@/lib/turn-changes";
import "./ArtifactChanges.css";

export interface ArtifactChangesProps {
  turns: TurnChange[];
  target?: { toolCallId: string; requestId: number } | null;
  active?: boolean;
  onTargetHandled: (requestId: number) => void;
}

const COPY = {
  en: {
    all: "All", latest: "Latest", scope: "Change scope", files: "files", turn: "Turn",
    written: "Written content", edit: "Edit", writes: "writes", more: "Show more rows",
    empty: "No recorded edits or writes yet.",
    note: "Only successful edit and write calls are shown. Shell and manual changes are not included.",
  },
  "zh-CN": {
    all: "全部", latest: "最近一轮", scope: "变更范围", files: "个文件", turn: "轮次",
    written: "写入内容", edit: "编辑", writes: "次写入", more: "展开更多行",
    empty: "暂无已记录的编辑或写入。",
    note: "仅显示成功的 edit 和 write 调用，不包含命令行或手动变更。",
  },
};
type Copy = typeof COPY.en;

function Stats({ files }: { files: TurnFileChange[] }) {
  const edits = files.flatMap((file) => file.sections).some((section) => section.kind === "edit");
  if (!edits) return null;
  return (
    <span className="artifact-changes-stats" title="edit">
      <span className="artifact-changes-added">+{files.reduce((sum, file) => sum + file.added, 0)}</span>{" "}
      <span className="artifact-changes-removed">−{files.reduce((sum, file) => sum + file.removed, 0)}</span>
    </span>
  );
}

function Section({ section, copy }: { section: TurnChangeSection; copy: Copy }) {
  const [expanded, setExpanded] = useState(false);
  const rows: TurnChangeRow[] = section.kind === "edit" ? section.rows :
    (section.content === "" ? [] : section.content.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n")).map((text, index) => ({
      kind: "context", oldNo: null, newNo: index + 1, text,
    }));
  const visible = expanded ? rows : rows.slice(0, 120);
  return (
    <section className="artifact-changes-section" data-tool-call-id={section.toolCallId}>
      <div className="artifact-changes-section-label">{section.kind === "write" ? copy.written : copy.edit}</div>
      <div className="artifact-changes-table">
        {visible.map((row, index) => row.kind === "hunk" ? (
          <div key={index} className="artifact-changes-hunk" style={{ "--i": index } as CSSProperties}>{row.text}</div>
        ) : (
          <div key={index} className={`artifact-changes-line artifact-changes-line-${row.kind}`} style={{ "--i": index } as CSSProperties}>
            <span className="artifact-changes-gutter">{row.oldNo ?? ""}</span>
            <span className="artifact-changes-gutter">{row.newNo ?? ""}</span>
            <span className="artifact-changes-code">{row.kind === "added" ? "+" : row.kind === "removed" ? "−" : " "} {row.text}</span>
          </div>
        ))}
      </div>
      {!expanded && rows.length > 120 && (
        <button type="button" className="artifact-changes-more" onClick={() => setExpanded(true)}>{copy.more} ({rows.length - 120})</button>
      )}
    </section>
  );
}

function FileCard({ file, defaultOpen, copy }: { file: TurnFileChange; defaultOpen: boolean; copy: Copy }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <details className="artifact-changes-card" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="artifact-changes-file-head">
        <svg className="artifact-changes-file-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" /><path d="M14 2v6h6" />
        </svg>
        <span className="artifact-changes-path" title={file.path}>{`\u200e${file.path}`}</span>
        <Stats files={[file]} />
        <span className="artifact-changes-chevron" aria-hidden="true">›</span>
      </summary>
      <div className="artifact-changes-card-body">
        {file.sections.map((section) => <Section key={section.toolCallId} section={section} copy={copy} />)}
      </div>
    </details>
  );
}

export function ArtifactChanges({ turns, target, active = true, onTargetHandled }: ArtifactChangesProps) {
  const { locale } = useI18n();
  const copy = locale === "zh-CN" ? COPY["zh-CN"] : COPY.en;
  const [scope, setScope] = useState<"all" | "latest">("all");
  const rootRef = useRef<HTMLDivElement>(null);
  const latest = turns.at(-1);
  const visibleTurns = scope === "latest" ? turns.slice(-1) : turns;
  const files = visibleTurns.flatMap((turn) => turn.files);
  const writes = files.flatMap((file) => file.sections).filter((section) => section.kind === "write").length;

  useEffect(() => {
    if (!active || !target) return;
    const turn = turns.find((turn) => turn.files.some((file) => file.sections.some((section) => section.toolCallId === target.toolCallId)));
    if (!turn) return;
    if (scope === "latest" && turn !== latest) {
      setScope("all");
      return;
    }
    const frame = requestAnimationFrame(() => {
      const section = Array.from(rootRef.current?.querySelectorAll<HTMLElement>("[data-tool-call-id]") ?? [])
        .find((element) => element.dataset.toolCallId === target.toolCallId);
      const card = section?.closest("details");
      if (!section || !(card instanceof HTMLDetailsElement)) return;
      card.open = true;
      section.scrollIntoView({ block: "center", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
      section.classList.remove("artifact-changes-flash");
      void section.offsetWidth;
      section.classList.add("artifact-changes-flash");
      onTargetHandled(target.requestId);
    });
    return () => cancelAnimationFrame(frame);
  }, [active, target, turns, latest, scope, onTargetHandled]);

  return (
    <div className="artifact-changes" ref={rootRef}>
      <div className="artifact-changes-head">
        <span className="artifact-changes-summary">{files.length} {copy.files} <Stats files={files} />{writes > 0 && <span> · {writes} {copy.writes}</span>}</span>
        <fieldset className="artifact-changes-scope" aria-label={copy.scope}>
          <button type="button" aria-pressed={scope === "all"} onClick={() => setScope("all")}>{copy.all}</button>
          <button type="button" aria-pressed={scope === "latest"} onClick={() => setScope("latest")}>{copy.latest}</button>
        </fieldset>
      </div>
      <div className="artifact-changes-scroll">
        {files.length === 0 && <div className="artifact-changes-empty">{copy.empty}</div>}
        {[...turns].reverse().map((turn, turnIndex) => (
          <div className="artifact-changes-turn" key={turn.id} hidden={scope === "latest" && turn !== latest}>
            <div className="artifact-changes-turn-head"><span>{copy.turn} {turn.turnIndex + 1}</span><Stats files={turn.files} /></div>
            {turn.files.map((file, fileIndex) => <FileCard key={file.path} file={file} defaultOpen={turnIndex === 0 && fileIndex === 0} copy={copy} />)}
          </div>
        ))}
        <p className="artifact-changes-note">{copy.note}</p>
      </div>
    </div>
  );
}
