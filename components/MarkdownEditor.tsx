"use client";
import dynamic from "next/dynamic";
import { useEffect } from "react";
import { useI18n } from "@/hooks/useI18n";

export interface MarkdownEditorProps {
  filePath: string; value: string; cwd?: string; sourceSessionId?: string | null; dark: boolean;
  onChange: (value: string) => void; onFlush: () => void; onComposition: (active: boolean) => void;
  onOpenFile?: (path: string) => void; onUnsafe: (reason: string) => void;
}
function LoadingEditor() {
  const { t } = useI18n();
  return <div role="status" style={{ padding: "24px 32px", color: "var(--text-muted)" }}>{t("i18n.loading")}</div>;
}
function FailedEditor({ onUnsafe }: MarkdownEditorProps) {
  useEffect(() => { onUnsafe("Editor loading failed; reload to retry"); }, [onUnsafe]);
  return null;
}
const InitializedMarkdownEditor = dynamic(async () => {
  try { return (await import("./InitializedMarkdownEditor")).default; }
  catch (error) { console.error("Markdown editor failed to load", error); return FailedEditor; }
}, { ssr: false, loading: LoadingEditor });
export function MarkdownEditor(props: MarkdownEditorProps) {
  return <InitializedMarkdownEditor {...props} />;
}
