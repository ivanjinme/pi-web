"use client";
import { useEffect, useLayoutEffect, useRef } from "react";
import { basicSetup } from "codemirror";
import { Compartment, EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { css } from "@codemirror/lang-css";
import { languages } from "@codemirror/language-data";

import { sourceLineRange, type SourceLineRange } from "@/lib/source-lines";
import { createSourceTextExtension, sourceTextField, externalSourceText } from "@/lib/source-editor-state";
interface Props {
  filePath: string; value: string; language: string; dark: boolean; wrap: boolean;
  onChange: (value: string) => void; onFlush: () => void;
  onComposition: (active: boolean) => void; onSelection: (range: SourceLineRange | null) => void;
  onMention: (range: SourceLineRange | null) => void;
  onLanguageFallback: (plain: boolean) => void;
}
export function SourceEditor(props: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const createState = useRef<((value: string, previous?: EditorState) => EditorState) | null>(null);
  const latest = useRef(props);
  const config = useRef(new Compartment());
  const languageConfig = useRef(new Compartment());
  useLayoutEffect(() => { latest.current = props; });
  useEffect(() => {
    if (!host.current) return;
    const initial = latest.current;
    latest.current.onSelection(null);
    createState.current = (value, previous) => EditorState.create({
      doc: value,
      extensions: [basicSetup,
        config.current.of(previous ? config.current.get(previous) ?? [] : []),
        languageConfig.current.of(previous ? languageConfig.current.get(previous) ?? [] : []),
        createSourceTextExtension(value),
        Prec.high(keymap.of([
          { key: "Mod-i", preventDefault: true, run: (v) => { const s = v.state.selection.main; latest.current.onMention(sourceLineRange(v.state.doc, s.from, s.to)); return true; } },
        ])),
        EditorView.updateListener.of((update) => {
          const text = update.state.field(sourceTextField).text;
          if (text !== update.startState.field(sourceTextField).text &&
              !update.transactions.some((tr) => tr.annotation(externalSourceText) !== undefined)) {
            latest.current.onChange(text);
          }
          if (update.selectionSet || update.docChanged) {
            const s = update.state.selection.main;
            latest.current.onSelection(sourceLineRange(update.state.doc, s.from, s.to));
          }
        }),
        EditorView.domEventHandlers({
          compositionstart: () => { latest.current.onComposition(true); },
          compositionend: () => { latest.current.onComposition(false); },
          blur: (event, v) => { if (!(event.relatedTarget instanceof Node) || !v.dom.contains(event.relatedTarget)) latest.current.onFlush(); },
        }),
      ],
    });
    const instance = new EditorView({ parent: host.current, state: createState.current(initial.value) });
    view.current = instance;
    return () => { latest.current.onSelection(null); latest.current.onComposition(false); latest.current.onFlush(); instance.destroy(); view.current = null; createState.current = null; };
  }, [props.filePath]);
  useLayoutEffect(() => {
    const instance = view.current;
    if (!instance || !createState.current || instance.state.field(sourceTextField).text === props.value) return;
    // 不同的外部全文是新历史基线，不能把旧撤销中的换行位置映射到新文档。
    instance.setState(createState.current(props.value, instance.state));
    latest.current.onSelection(null);
  }, [props.value]);
  useEffect(() => {
    view.current?.dispatch({ effects: config.current.reconfigure([
      ...(props.wrap ? [EditorView.lineWrapping] : []),
      EditorView.theme({
        "&": { height: "100%", fontSize: "13px", backgroundColor: "var(--bg)", color: "var(--text)" },
        ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.6", overflow: "auto" },
        ".cm-content": { padding: "0", minHeight: "100%" },
        ".cm-gutters": { backgroundColor: "var(--bg-panel)", color: "var(--text-dim)", borderRight: "1px solid var(--border)" },
        ".cm-lineNumbers .cm-gutterElement": { minWidth: "38px", padding: "0 10px" },
        ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "var(--bg-selected)" },
        ".cm-cursor": { borderLeftColor: "var(--text)" },
        ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": { backgroundColor: "var(--bg-selected)" },
      }, { dark: props.dark }),
    ]) });
  }, [props.wrap, props.dark, props.filePath]);
  useEffect(() => {
    let cancelled = false;
    let extension: ReturnType<typeof markdown> | null = null;
    switch (props.language) {
      case "markdown": extension = markdown(); break;
      case "html": extension = html(); break;
      case "javascript":
      case "typescript":
        extension = javascript({ typescript: props.language === "typescript", jsx: /\.[jt]sx$/i.test(props.filePath) });
        break;
      case "json": extension = json(); break;
      case "css": extension = css(); break;
    }
    if (extension) {
      latest.current.onLanguageFallback(false);
      view.current?.dispatch({ effects: languageConfig.current.reconfigure(extension) });
    }
    else {
      let alias = props.language;
      if (alias === "bash") alias = "shell";
      else if (alias === "csharp") alias = "c#";
      const match = languages.find((lang) => lang.name.toLowerCase() === alias || lang.alias.some((name) => name.toLowerCase() === alias));
      latest.current.onLanguageFallback(!match && props.language !== "text");
      view.current?.dispatch({ effects: languageConfig.current.reconfigure([]) });
      if (match) void match.load().then((support) => {
        if (!cancelled) view.current?.dispatch({ effects: languageConfig.current.reconfigure(support) });
      }).catch((error: unknown) => {
        if (!cancelled) { latest.current.onLanguageFallback(true); console.error("Source language failed to load", error); }
      });
    }
    return () => { cancelled = true; };
  }, [props.language, props.filePath]);
  return <div ref={host} className="file-source-editor" style={{ height: "100%", minHeight: 0 }} />;
}
