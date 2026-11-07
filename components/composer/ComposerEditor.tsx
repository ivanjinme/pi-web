"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef, type ClipboardEvent, type KeyboardEvent } from "react";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { PlainTextPlugin } from "@lexical/react/LexicalPlainTextPlugin";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { CLEAR_HISTORY_COMMAND, HISTORY_PUSH_TAG, SKIP_DOM_SELECTION_TAG } from "lexical";
import { completionText, serializeComposer, type ComposerPart } from "@/lib/composer";
import { SkillNode } from "./SkillNode";
import { FileNode } from "./FileNode";
import { $insertParts, $readDocument, $replaceDocument, $selectRange, selectedParts } from "./editor-document";

const CLIPBOARD_TYPE = "application/x-weclio-composer";

export interface ComposerEditorHandle {
  focus: (position?: number) => void;
  selection: () => { start: number; end: number };
  replace: (start: number, end: number, parts: ComposerPart[]) => void;
  contains: (target: Node) => boolean;
}

interface Props {
  parts: ComposerPart[];
  placeholder: string;
  onChange: (parts: ComposerPart[]) => void;
  onSelectionChange: (text: string, cursor: number) => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  onPaste: (event: ClipboardEvent<HTMLDivElement>) => void;
  onCompositionStart: () => void;
  onCompositionEnd: () => void;
}

const Editor = forwardRef<ComposerEditorHandle, Props>(function Editor(props, ref) {
  const [editor] = useLexicalComposerContext();
  const latest = useRef(props);
  latest.current = props;
  const lastParts = useRef(JSON.stringify(props.parts));

  useEffect(() => editor.registerUpdateListener(({ editorState }) => {
    editorState.read(() => {
      const { parts, start, end } = $readDocument();
      const serialized = JSON.stringify(parts);
      if (lastParts.current !== serialized) {
        lastParts.current = serialized;
        latest.current.onChange(parts);
      }
      if (!editor.isComposing()) {
        latest.current.onSelectionChange(completionText(parts), start === end ? start : -1);
      }
    });
  }), [editor]);

  useEffect(() => {
    const serialized = JSON.stringify(props.parts);
    if (serialized === lastParts.current) return;
    lastParts.current = serialized;
    // 外部替换用于发送清空、草稿和历史恢复；普通编辑不重建文档或撤销栈。
    editor.update(() => $replaceDocument(props.parts), { tag: SKIP_DOM_SELECTION_TAG });
    editor.dispatchCommand(CLEAR_HISTORY_COMMAND, undefined);
  }, [editor, props.parts]);

  useImperativeHandle(ref, () => ({
    focus(position) {
      if (position !== undefined) editor.update(() => $selectRange(position));
      editor.focus();
    },
    selection() {
      return editor.getEditorState().read(() => {
        const { start, end } = $readDocument();
        return { start, end };
      });
    },
    replace(start, end, parts) {
      editor.update(() => {
        $selectRange(start, end);
        $insertParts(parts);
      }, { tag: HISTORY_PUSH_TAG });
      editor.focus();
    },
    contains(target) { return editor.getRootElement()?.contains(target) ?? false; },
  }), [editor]);

  const copy = (event: ClipboardEvent<HTMLDivElement>, cut = false) => {
    const selected = editor.getEditorState().read(() => {
      const { parts, start, end } = $readDocument();
      return start === end ? null : { parts: selectedParts(parts, start, end), start, end };
    });
    if (!selected) return;
    event.preventDefault();
    event.stopPropagation();
    event.clipboardData.setData(CLIPBOARD_TYPE, JSON.stringify(selected.parts));
    event.clipboardData.setData("text/plain", serializeComposer(selected.parts));
    if (cut) editor.update(() => { $selectRange(selected.start, selected.end); $insertParts([]); }, { tag: HISTORY_PUSH_TAG });
  };

  return (
    <PlainTextPlugin
      ErrorBoundary={LexicalErrorBoundary}
      contentEditable={
        <ContentEditable
          className="composer-editor"
          aria-label={props.placeholder}
          aria-placeholder={props.placeholder}
          placeholder={<span className="composer-placeholder">{props.placeholder}</span>}
          onKeyDownCapture={(event) => {
            props.onKeyDown(event);
            if (event.defaultPrevented) event.stopPropagation();
          }}
          onCompositionStart={props.onCompositionStart}
          onCompositionEnd={props.onCompositionEnd}
          onCopyCapture={(event) => copy(event)}
          onCutCapture={(event) => copy(event, true)}
          onPasteCapture={(event) => {
            props.onPaste(event);
            if (!event.defaultPrevented) {
              const data = event.clipboardData.getData(CLIPBOARD_TYPE);
              if (data) {
                const parts = JSON.parse(data) as ComposerPart[];
                event.preventDefault();
                editor.update(() => $insertParts(parts), { tag: HISTORY_PUSH_TAG });
              }
            }
            if (event.defaultPrevented) event.stopPropagation();
          }}
        />
      }
    />
  );
});

export const ComposerEditor = forwardRef<ComposerEditorHandle, Props>(function ComposerEditor(props, ref) {
  const config = useRef({
    namespace: "weclio-composer",
    nodes: [SkillNode, FileNode],
    theme: { paragraph: "composer-paragraph" },
    onError(error: Error) { throw error; },
    editorState: () => $replaceDocument(props.parts),
  });
  return (
    <LexicalComposer initialConfig={config.current}>
      <div className="composer-content">
        <Editor {...props} ref={ref} />
      </div>
      <HistoryPlugin />
    </LexicalComposer>
  );
});
