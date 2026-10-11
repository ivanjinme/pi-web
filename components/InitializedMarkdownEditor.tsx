"use client";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { MDXEditor, headingsPlugin, listsPlugin, quotePlugin, thematicBreakPlugin, linkPlugin, linkDialogPlugin,
  imagePlugin, tablePlugin, codeBlockPlugin, codeMirrorPlugin, markdownShortcutPlugin, type MDXEditorMethods } from "@mdxeditor/editor";
import "@mdxeditor/editor/style.css";
import { getFileDirectory, encodeFilePathForApi } from "@/lib/file-paths";
import { resolveLocalFileHref } from "@/lib/file-links";
import { markdownUrlTransform } from "@/lib/markdown";
import { isSafeMarkdownRoundTrip, markdownEnvelope, markdownFallbackReason, restoreMarkdownEnvelope } from "@/lib/markdown-editing";
import type { MarkdownEditorProps } from "./MarkdownEditor";

export default function InitializedMarkdownEditor(props: MarkdownEditorProps) {
  const editor = useRef<MDXEditorMethods>(null);
  const host = useRef<HTMLDivElement>(null);
  const lastText = useRef(props.value);
  const lastSerialized = useRef(markdownEnvelope(props.value).body);
  const syncing = useRef(true);
  const [ready, setReady] = useState(false);
  const [baseline, setBaseline] = useState(() => ({ revision: 0, markdown: markdownEnvelope(props.value).body, focused: false }));
  const latest = useRef(props);
  useLayoutEffect(() => { latest.current = props; });
  useEffect(() => () => { latest.current.onComposition(false); latest.current.onFlush(); }, []);
  const directory = getFileDirectory(props.filePath);
  const plugins = useMemo(() => [headingsPlugin(), listsPlugin(), quotePlugin(), thematicBreakPlugin(),
    linkPlugin({ validateUrl: (url) => Boolean(markdownUrlTransform(url)) }), linkDialogPlugin(),
    imagePlugin({ imagePreviewHandler: async (url) => {
      const local = resolveLocalFileHref(url, directory, props.cwd ?? directory);
      const params = new URLSearchParams({ type: "read" });
      if (props.sourceSessionId) params.set("sessionId", props.sourceSessionId);
      return local ? `/api/files/${encodeFilePathForApi(local)}?${params}` : markdownUrlTransform(url);
    } }), tablePlugin(), codeBlockPlugin({ defaultCodeBlockLanguage: "" }),
    codeMirrorPlugin({ codeBlockLanguages: { "": "Text", js: "JavaScript", ts: "TypeScript", jsx: "JSX", tsx: "TSX", css: "CSS", html: "HTML", bash: "Shell", json: "JSON", python: "Python" } }),
    markdownShortcutPlugin()], [directory, props.cwd, props.sourceSessionId]);
  useLayoutEffect(() => {
    const incoming = props.value;
    if (ready && incoming === lastText.current) return;
    syncing.current = true;
    // 不同的外部全文重建编辑基线，同时清空正文与嵌套编辑区的 Undo/Redo。
    if (incoming !== lastText.current) {
      lastText.current = incoming;
      setReady(false);
      const focused = host.current?.contains(document.activeElement) ?? false;
      setBaseline((previous) => ({ revision: previous.revision + 1, markdown: markdownEnvelope(incoming).body, focused }));
    }
    let frame: number;
    const validate = () => {
      if (!host.current?.querySelector(".mdxeditor-root-contenteditable [contenteditable]")) {
        frame = requestAnimationFrame(validate); return;
      }
      const output = editor.current?.getMarkdown() ?? "";
      if (!isSafeMarkdownRoundTrip(incoming, output)) {
        latest.current.onUnsafe("Markdown round-trip"); return;
      }
      lastSerialized.current = output;
      syncing.current = false;
      setReady(true);
    };
    frame = requestAnimationFrame(validate);
    return () => cancelAnimationFrame(frame);
  }, [props.value, ready]);
  return <div ref={host} className={`file-markdown-editor ${props.dark ? "dark-theme" : ""}`}
    onCompositionStart={() => props.onComposition(true)} onCompositionEnd={() => props.onComposition(false)}
    onBlurCapture={(event) => {
      const related = event.relatedTarget;
      if (related instanceof Element && (event.currentTarget.contains(related) || related.closest(".mdxeditor-popup-container"))) return;
      props.onFlush();
    }}
    onClickCapture={(event) => {
      const target = event.target instanceof Element ? event.target.closest("a") : null;
      if (!target) return;
      const href = target.getAttribute("href") ?? "";
      if (!markdownUrlTransform(href)) { event.preventDefault(); event.stopPropagation(); return; }
      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      const local = resolveLocalFileHref(href, directory, props.cwd ?? directory);
      if (local && props.onOpenFile) { event.preventDefault(); event.stopPropagation(); props.onOpenFile(local); }
    }}>
    <MDXEditor key={baseline.revision} ref={editor} markdown={baseline.markdown} autoFocus={baseline.focused} trim={false} readOnly={!ready} className={props.dark ? "dark-theme" : undefined}
      contentEditableClassName="markdown-body markdown-file-preview" plugins={plugins}
      toMarkdownOptions={{ bullet: "-", rule: "-", emphasis: "*", strong: "*", fences: true }}
      onError={() => { syncing.current = true; props.onUnsafe("Markdown parsing"); }}
      onChange={(markdown, initial) => {
        if (initial) {
          if (!isSafeMarkdownRoundTrip(lastText.current, markdown)) { syncing.current = true; props.onUnsafe("Markdown round-trip"); }
          return;
        }
        if (syncing.current || !ready || markdown === lastSerialized.current) return;
        const reason = markdownFallbackReason(markdown, props.filePath);
        if (reason) syncing.current = true;
        const text = restoreMarkdownEnvelope(markdown, lastText.current);
        lastText.current = text;
        lastSerialized.current = markdown;
        // 用户输入先交给共享草稿，再降级卸载；初始化与解析失败仍禁止写回。
        props.onChange(text);
        if (reason) props.onUnsafe(reason);
      }} />
  </div>;
}
