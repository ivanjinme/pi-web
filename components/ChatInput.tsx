"use client";

import React, { useRef, useState, useCallback, useEffect, useImperativeHandle, forwardRef, KeyboardEvent } from "react";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { BuiltinSlashCommandResult, CompactResultInfo, QueuedMessages, SlashCommandInfo, ThinkingLevelOption } from "@/hooks/useAgentSession";
import { clearDraft, getDraft, setDraft, type ChatDraftImage } from "@/lib/draft-store";
import { NewTaskProjectPicker } from "./NewTaskProjectPicker";
import { ComposerEditor, type ComposerEditorHandle } from "./composer/ComposerEditor";
import { ContextRing, ModelThinkingPicker, PermissionPicker } from "./composer/ComposerControls";
import { composerText, completionText, extractSlashToken, restoreComposerText, serializeComposer, textParts, type ComposerPart } from "@/lib/composer";
import {
  MAX_ATTACHED_IMAGE_BYTES,
  MAX_ATTACHED_IMAGES,
  isBase64ImageWithinLimits,
} from "@/lib/image-attachments";
import {
  buildEntriesFromFiles, buildAtInsertText, extractAtQuery, filterFileEntries,
  type AtQueryMatch, type FileIndexEntry,
} from "@/lib/file-fuzzy";
import { FolderIcon, getFileIcon } from "./FileIcons";
import { useI18n } from "@/hooks/useI18n";

export interface AttachedImage {
  data: string;   // base64, no prefix
  mimeType: string;
  previewUrl: string; // object URL for display
}

interface Props {
  onSend: (message: string, images?: AttachedImage[], parts?: ComposerPart[]) => boolean | void | Promise<boolean | void>;
  onAbort: () => void;
  onSteer?: (message: string, images?: AttachedImage[], parts?: ComposerPart[]) => void | Promise<void>;
  onFollowUp?: (message: string, images?: AttachedImage[], parts?: ComposerPart[]) => void | Promise<void>;
  onPromptWithStreamingBehavior?: (message: string, behavior: "steer" | "followUp", images?: AttachedImage[], parts?: ComposerPart[]) => void | Promise<void>;
  isStreaming: boolean;
  contextUsage?: { percent: number | null; contextWindow: number; tokens: number | null } | null;
  model?: { provider: string; modelId: string } | null;
  isAutoModelSelection?: boolean;
  modelNames?: Record<string, string>;
  modelList?: { id: string; name: string; provider: string }[];
  modelError?: string | null;
  onModelChange?: (provider: string, modelId: string) => void;
  compactResult?: CompactResultInfo | null;
  canCompact?: boolean;
  isCompacting?: boolean;
  toolPreset?: "none" | "default" | "full";
  onToolPresetChange?: (preset: "none" | "default" | "full") => void;
  thinkingLevel?: ThinkingLevelOption | null;
  onThinkingLevelChange?: (level: ThinkingLevelOption) => void;
  availableThinkingLevels?: ThinkingLevel[] | null;
  retryInfo?: { attempt: number; maxAttempts: number; errorMessage?: string } | null;
  queuedMessages?: QueuedMessages | null;
  inputHistory?: string[];
  onRecallQueue?: () => void | Promise<void>;
  onDeleteQueue?: () => void | Promise<void>;
  slashCommands?: SlashCommandInfo[];
  slashCommandsLoading?: boolean;
  onLoadSlashCommands?: () => Promise<SlashCommandInfo[]> | SlashCommandInfo[];
  onBuiltinCommand?: (message: string) => Promise<BuiltinSlashCommandResult>;
  onAudioUnlock?: () => void;
  draftKey?: string;
  /** Session working directory — enables the @ file autocomplete menu */
  cwd?: string | null;
  autoFocus?: boolean;
  projectPicker?: {
    resetKey: string;
    selectedCwd: string | null;
    onSelect: (cwd: string) => void;
    onClear: () => void;
  };
}

export interface ChatInputHandle {
  insertText: (text: string) => void;
  insertIfEmpty: (text: string) => void;
  prependText: (text: string) => void;
  addImages: (files: File[]) => void;
}

const COMPOSITION_END_ENTER_GRACE_MS = 100;
const COMMAND_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return tokens.toLocaleString();
}

type SlashCommandPaletteItem = SlashCommandInfo | {
  name: string;
  description: string;
  source: "builtin";
};

type SlashCommandSource = SlashCommandPaletteItem["source"];

function SlashCommandIcon({ command, size = 14 }: { command: SlashCommandPaletteItem; size?: number }) {
  const builtinPaths: Record<string, React.ReactNode> = {
    compact: <><path d="M4 7V4h3" /><path d="M16 7V4h-3" /><path d="M4 13v3h3" /><path d="M16 13v3h-3" /><path d="m7 10 3 3 3-3" /><path d="M10 7v6" /></>,
    reload: <><path d="M15.5 7.5A6 6 0 1 0 16 12" /><path d="M15.5 4.5v3h-3" /></>,
    name: <><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h7A2.5 2.5 0 0 1 16 5.5v9a2.5 2.5 0 0 1-2.5 2.5h-7A2.5 2.5 0 0 1 4 14.5Z" /><path d="M7 7.5h6" /><path d="M7 10.5h4.5" /></>,
    session: <><circle cx="10" cy="10" r="6.5" /><path d="M10 6.5V10l2.5 1.5" /></>,
    copy: <><rect x="7" y="7" width="9" height="10" rx="1.5" /><path d="M4 13V4.5A1.5 1.5 0 0 1 5.5 3H13" /></>,
  };
  const sourcePaths: Record<Exclude<SlashCommandSource, "builtin">, React.ReactNode> = {
    extension: <><path d="M8.2 4.2v4.1" /><path d="M5.1 8.3h6.2a2.7 2.7 0 0 1 0 5.4H10v2.1H6v-2.1H4.7a2.7 2.7 0 0 1 0-5.4Z" /><path d="M6 4.2h4.2" /></>,
    prompt: <><path d="M5 3.5h7l3 3v10H5z" /><path d="M12 3.5v3h3" /><path d="M7.5 10h5" /><path d="M7.5 12.8h4" /></>,
    skill: <><path d="m10 2 1.25 5.75L17 9l-5.75 1.25L10 16l-1.25-5.75L3 9l5.75-1.25Z" /><path d="m16 14 .55 2.45L19 17l-2.45.55L16 20l-.55-2.45L13 17l2.45-.55Z" /></>,
  };
  const paths = command.source === "builtin"
    ? builtinPaths[command.name] ?? <><path d="M4 5.5 8.5 10 4 14.5" /><path d="M11 14.5h5" /></>
    : sourcePaths[command.source];
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths}
    </svg>
  );
}

const BUILTIN_SLASH_COMMANDS: SlashCommandPaletteItem[] = [
  { name: "compact", description: "chat.commandCompact", source: "builtin" },
  { name: "reload", description: "chat.commandReload", source: "builtin" },
  { name: "name", description: "chat.commandName", source: "builtin" },
];

const SLASH_SOURCE_ORDER: Record<SlashCommandSource, number> = {
  builtin: 0,
  extension: 1,
  prompt: 2,
  skill: 3,
};

function slashMatchRank(command: SlashCommandPaletteItem, query: string, t: (key: string) => string): number {
  const name = command.name.toLowerCase();
  const description = getSlashDescription(command, t).toLowerCase();
  if (name === query) return 0;
  if (name.startsWith(query)) return 1;
  if (name.includes(query)) return 2;
  if (description.includes(query)) return 3;
  return 4;
}

function getSlashDescription(command: SlashCommandPaletteItem, t: (key: string) => string): string {
  return command.source === "builtin" ? t(command.description) : command.description ?? "";
}

function getSlashCommandLabel(command: SlashCommandPaletteItem): string {
  return command.source === "skill" ? command.name.replace(/^skills?:/i, "") : command.name;
}

function imageToDraftImage(image: AttachedImage): ChatDraftImage {
  return { data: image.data, mimeType: image.mimeType };
}

function draftImageToAttachedImage(image: ChatDraftImage): AttachedImage {
  return {
    ...image,
    previewUrl: `data:${image.mimeType};base64,${image.data}`,
  };
}

function draftImagesToAttachedImages(images: ChatDraftImage[] | undefined): AttachedImage[] {
  return (images ?? [])
    .filter(isBase64ImageWithinLimits)
    .slice(0, MAX_ATTACHED_IMAGES)
    .map(draftImageToAttachedImage);
}

function revokeImagePreview(image: AttachedImage): void {
  if (image.previewUrl.startsWith("blob:")) {
    URL.revokeObjectURL(image.previewUrl);
  }
}

export function ModelErrorBanner({ error }: { error?: string | null }) {
  if (!error) return null;
  return (
    <div
      role="alert"
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 8,
        maxHeight: 120,
        marginBottom: 8,
        padding: "7px 10px",
        overflowY: "auto",
        border: "1px solid rgba(239,68,68,0.3)",
        borderRadius: 6,
        background: "rgba(239,68,68,0.07)",
        color: "#ef4444",
        fontSize: 11,
        lineHeight: 1.45,
      }}
    >
      <svg
        width="13"
        height="13"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ flexShrink: 0, marginTop: 1 }}
        aria-hidden="true"
      >
        <path d="M10.3 2.9 1.8 17a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 2.9a2 2 0 0 0-3.4 0Z" />
        <line x1="12" y1="9" x2="12" y2="13" />
        <line x1="12" y1="17" x2="12.01" y2="17" />
      </svg>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 600 }}>Model error</div>
        <div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{error}</div>
      </div>
    </div>
  );
}

export const ChatInput = forwardRef<ChatInputHandle, Props>(function ChatInput({
  onSend, onAbort, onSteer, onFollowUp, isStreaming, model, isAutoModelSelection, modelNames, modelList, modelError, onModelChange,
  compactResult, canCompact = false, isCompacting = false, contextUsage,
  thinkingLevel, onThinkingLevelChange, availableThinkingLevels,
  retryInfo, queuedMessages, inputHistory = [], onRecallQueue, onDeleteQueue,
  slashCommands, slashCommandsLoading, onLoadSlashCommands,
  onBuiltinCommand,
  onAudioUnlock,
  onPromptWithStreamingBehavior,
  draftKey,
  cwd,
  autoFocus = false,
  projectPicker,
}: Props, ref) {
  const { t } = useI18n();
  const [parts, setParts] = useState<ComposerPart[]>(() => {
    const draft = draftKey ? getDraft(draftKey) : null;
    return draft?.parts ?? [];
  });
  const value = composerText(parts);
  const [cursor, setCursor] = useState(value.length);
  const skillParts = parts.some((part) => part.type === "skill") ? parts : undefined;
  const [attachedImages, setAttachedImages] = useState<AttachedImage[]>(() => (
    draftKey ? draftImagesToAttachedImages(getDraft(draftKey)?.images) : []
  ));
  const trimmedValue = value.trimStart();
  const bashMode = !skillParts && attachedImages.length === 0 && trimmedValue.startsWith("!");
  const bashExcluded = bashMode && trimmedValue.startsWith("!!");
  const [slashMenuOpen, setSlashMenuOpen] = useState(false);
  const [slashActiveIndex, setSlashActiveIndex] = useState(0);
  const [atQuery, setAtQuery] = useState<AtQueryMatch | null>(null);
  const [atMenuOpen, setAtMenuOpen] = useState(false);
  const [atActiveIndex, setAtActiveIndex] = useState(0);
  const [historyMenuOpen, setHistoryMenuOpen] = useState(false);
  const [historyActiveIndex, setHistoryActiveIndex] = useState(0);
  const [queueAction, setQueueAction] = useState<"edit" | "delete" | null>(null);
  const [queueSubmitting, setQueueSubmitting] = useState(false);
  const [sendSubmitting, setSendSubmitting] = useState(false);
  const [fileIndex, setFileIndex] = useState<{ cwd: string; entries: FileIndexEntry[]; truncated: boolean } | null>(null);
  const [fileIndexLoading, setFileIndexLoading] = useState(false);
  const [atServerResult, setAtServerResult] = useState<{ cwd: string; query: string; matches: FileIndexEntry[] } | null>(null);

  const editorRef = useRef<ComposerEditorHandle>(null);
  const historyMenuRef = useRef<HTMLDivElement>(null);
  const isComposingRef = useRef(false);
  const lastCompositionEndAtRef = useRef(0);
  const slashCommandsRequestedRef = useRef(false);
  const slashItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const atItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const historyItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const fileIndexMetaRef = useRef<{ cwd: string; fetchedAt: number } | null>(null);
  const fileIndexFetchingRef = useRef<string | null>(null);
  const draftKeyRef = useRef(draftKey);
  const partsRef = useRef(parts);
  const attachedImagesRef = useRef(attachedImages);
  const pendingImageCountRef = useRef(0);
  const queueSubmitRef = useRef(false);
  const queueSubmitTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  partsRef.current = parts;
  attachedImagesRef.current = attachedImages;

  useImperativeHandle(ref, () => ({
    insertIfEmpty(text: string) {
      if (value.trim()) return;
      setParts(textParts(text));
      setAtQuery(null);
      requestAnimationFrame(() => editorRef.current?.focus());
    },
    prependText(text: string) {
      if (!text.trim()) return;
      const combined = [...restoreComposerText(text), ...textParts(value.trim() ? "\n\n" : ""), ...parts];
      setParts(combined);
      setAtQuery(null);
      requestAnimationFrame(() => editorRef.current?.focus(composerText(combined).length));
    },
    insertText(text: string) {
      const range = editorRef.current?.selection() ?? { start: value.length, end: value.length };
      const before = value.slice(0, range.start);
      const sep = before.length > 0 && !before.endsWith(" ") ? " " : "";
      editorRef.current?.replace(range.start, range.end, textParts(sep + text));
      setAtQuery(null);
    },
    addImages(files: File[]) {
      processImageFiles(files);
    },
  }));

  const processImageFiles = useCallback(async (files: File[]) => {
    if (isStreaming) return;
    const remaining = Math.max(
      0,
      MAX_ATTACHED_IMAGES - attachedImagesRef.current.length - pendingImageCountRef.current,
    );
    const imageFiles = files
      .filter((f) => f.type.startsWith("image/") && f.size <= MAX_ATTACHED_IMAGE_BYTES)
      .slice(0, remaining);
    if (!imageFiles.length) return;
    pendingImageCountRef.current += imageFiles.length;
    try {
      const newImages = await Promise.all(
        imageFiles.map(
          (file) =>
            new Promise<AttachedImage>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => {
                const result = reader.result as string;
                // result is "data:<mime>;base64,<data>"
                const base64 = result.split(",")[1];
                resolve({ data: base64, mimeType: file.type, previewUrl: URL.createObjectURL(file) });
              };
              reader.onerror = reject;
              reader.readAsDataURL(file);
            })
        )
      );
      setAttachedImages((prev) => {
        const accepted = newImages.slice(0, Math.max(0, MAX_ATTACHED_IMAGES - prev.length));
        newImages.slice(accepted.length).forEach(revokeImagePreview);
        return [...prev, ...accepted];
      });
    } finally {
      pendingImageCountRef.current -= imageFiles.length;
    }
  }, [isStreaming]);

  const removeImage = useCallback((index: number) => {
    setAttachedImages((prev) => {
      const next = [...prev];
      const [removed] = next.splice(index, 1);
      if (removed) revokeImagePreview(removed);
      return next;
    });
  }, []);

  const clearImages = useCallback(() => {
    setAttachedImages((prev) => {
      prev.forEach(revokeImagePreview);
      return [];
    });
  }, []);

  const resetInput = useCallback(() => {
    setParts([]);
    setAtQuery(null);
    setHistoryMenuOpen(false);
    if (draftKey) clearDraft(draftKey);
    if (draftKeyRef.current && draftKeyRef.current !== draftKey) clearDraft(draftKeyRef.current);
  }, [draftKey]);

  const clearInput = useCallback(() => {
    resetInput();
    clearImages();
  }, [clearImages, resetInput]);

  const detachInput = useCallback(() => {
    resetInput();
    setAttachedImages([]);
  }, [resetInput]);

  const restoreInput = useCallback((submitted: ComposerPart[], images: AttachedImage[]) => {
    setParts((current) => {
      if (!composerText(current).trim()) return submitted;
      if (!submitted.length || serializeComposer(current) === serializeComposer(submitted)) return current;
      return [...submitted, ...textParts("\n\n"), ...current];
    });
    setAttachedImages((current) => {
      const combined = [...images, ...current];
      combined.slice(MAX_ATTACHED_IMAGES).forEach(revokeImagePreview);
      return combined.slice(0, MAX_ATTACHED_IMAGES);
    });
    requestAnimationFrame(() => editorRef.current?.focus());
  }, []);

  const focusComposer = useCallback(() => {
    editorRef.current?.focus(composerText(partsRef.current).length);
  }, []);

  useEffect(() => {
    if (!autoFocus) return;
    let frame = 0;
    const content = document.getElementById("startup-content");
    // 开屏期间 inert 会拒绝聚焦，等散场解除后再执行一次。
    const observer = new MutationObserver(() => {
      if (!content?.inert) {
        observer.disconnect();
        frame = requestAnimationFrame(focusComposer);
      }
    });
    if (content?.inert) {
      observer.observe(content, { attributes: true, attributeFilter: ["inert"] });
    } else {
      frame = requestAnimationFrame(focusComposer);
    }
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [autoFocus, focusComposer]);

  useEffect(() => {
    if (!draftKey || draftKeyRef.current !== draftKey) return;
    setDraft(draftKey, {
      parts,
      images: attachedImages.map(imageToDraftImage),
    });
  }, [attachedImages, draftKey, parts]);

  useEffect(() => {
    const previousDraftKey = draftKeyRef.current;
    if (previousDraftKey === draftKey) return;

    if (previousDraftKey) {
      setDraft(previousDraftKey, {
        parts: partsRef.current,
        images: attachedImagesRef.current.map(imageToDraftImage),
      });
    }

    const draft = draftKey ? getDraft(draftKey) : null;
    draftKeyRef.current = draftKey;
    setParts(draft?.parts ?? []);
    setAtQuery(null);
    setHistoryMenuOpen(false);
    setAttachedImages((prev) => {
      prev.forEach(revokeImagePreview);
      return draftImagesToAttachedImages(draft?.images);
    });
  }, [draftKey]);

  useEffect(() => {
    return () => {
      attachedImagesRef.current.forEach(revokeImagePreview);
      if (queueSubmitTimeoutRef.current) clearTimeout(queueSubmitTimeoutRef.current);
    };
  }, []);

  const handleSend = useCallback(async () => {
    const msg = serializeComposer(parts).trim();
    if (!msg && !attachedImages.length) return;
    if (isStreaming || sendSubmitting) return;
    const submittedImages = attachedImages;
    let shouldRestore = true;
    onAudioUnlock?.();
    setSendSubmitting(true);
    detachInput();
    try {
      if (!skillParts && !submittedImages.length && msg.startsWith("/") && onBuiltinCommand) {
        const result = await onBuiltinCommand(msg);
        if (result.handled) {
          shouldRestore = false;
          return;
        }
      }
      const accepted = await onSend(msg, submittedImages.length ? submittedImages : undefined, skillParts);
      shouldRestore = accepted === false;
    } catch {
      // 错误由提交层展示；这里只负责恢复草稿。
    } finally {
      if (shouldRestore) restoreInput(parts, submittedImages);
      else submittedImages.forEach(revokeImagePreview);
      setSendSubmitting(false);
    }
  }, [parts, skillParts, attachedImages, isStreaming, sendSubmitting, onBuiltinCommand, onSend, detachInput, restoreInput, onAudioUnlock]);

  const slashToken = cursor < 0 ? null : extractSlashToken(completionText(parts), cursor);
  const slashQuery = slashToken?.query ?? null;

  const filteredSlashCommands = (() => {
    if (slashQuery === null) return [];
    const builtinCommands = isStreaming
      ? []
      : BUILTIN_SLASH_COMMANDS.filter((command) => command.name !== "compact" || (canCompact && !isCompacting));
    const commands = [...builtinCommands, ...(slashCommands ?? [])];
    return [...commands]
      .filter((command) => {
        const name = command.name.toLowerCase();
        const description = getSlashDescription(command, t).toLowerCase();
        return name.includes(slashQuery) || description.includes(slashQuery);
      })
      .sort((a, b) => {
        const rankDelta = slashMatchRank(a, slashQuery, t) - slashMatchRank(b, slashQuery, t);
        if (rankDelta !== 0) return rankDelta;
        return SLASH_SOURCE_ORDER[a.source] - SLASH_SOURCE_ORDER[b.source]
          || COMMAND_COLLATOR.compare(a.name, b.name);
      });
  })();

  const slashCommandCountLabel = filteredSlashCommands.length === 1
    ? t(slashQuery ? "chat.match" : "chat.command")
    : t(slashQuery ? "chat.matches" : "chat.commands", { count: filteredSlashCommands.length });
  const hasInputText = Boolean(value.trim());
  const queuedEntries = [
    ...(queuedMessages?.steering ?? []).map((text) => ({ kind: "steer" as const, text })),
    ...(queuedMessages?.followUp ?? []).map((text) => ({ kind: "followUp" as const, text })),
  ];
  const hasQueuedMessage = queuedEntries.length > 0;
  const canQueueStreamingMessage = hasInputText && attachedImages.length === 0 && !hasQueuedMessage && !queueSubmitting;
  const willSendSteer = isStreaming && !isCompacting && Boolean(onSteer) && canQueueStreamingMessage;
  // Disabled === cursor-not-allowed for the send/stop button; keep them in one place.
  const sendBlocked = sendSubmitting || (!isStreaming && !value.trim() && !attachedImages.length);
  const queueIconButtonStyle: React.CSSProperties = {
    display: "grid", placeItems: "center", width: 25, height: 25, padding: 0,
    border: "none", borderRadius: 6, background: "transparent",
    color: "var(--text-dim)", cursor: queueAction ? "not-allowed" : "pointer",
  };

  useEffect(() => {
    if (!hasQueuedMessage) setQueueAction(null);
    if (hasQueuedMessage || !isStreaming) {
      queueSubmitRef.current = false;
      setQueueSubmitting(false);
      if (queueSubmitTimeoutRef.current) clearTimeout(queueSubmitTimeoutRef.current);
      queueSubmitTimeoutRef.current = null;
    }
  }, [hasQueuedMessage, isStreaming]);

  const runQueueAction = useCallback(async (action: "edit" | "delete") => {
    const handler = action === "edit" ? onRecallQueue : onDeleteQueue;
    if (!handler || queueAction) return;
    setQueueAction(action);
    try {
      await handler();
    } finally {
      setQueueAction(null);
    }
  }, [onDeleteQueue, onRecallQueue, queueAction]);

  // ── @ file autocomplete ──────────────────────────────────────────────────
  // Recomputed from the text before the caret on every change/caret move.
  // Disabled entirely when there is no cwd (new session without a directory).
  const updateAtQuery = useCallback((text: string, cursor: number) => {
    setCursor(cursor);
    if (!cwd || cursor < 0) {
      setAtQuery(null);
      return;
    }
    setAtQuery(extractAtQuery(text.slice(0, cursor)));
  }, [cwd]);

  const atQueryText = atQuery?.query ?? null;
  const atLocalMatches: FileIndexEntry[] = React.useMemo(() => (
    atQueryText !== null && fileIndex && fileIndex.cwd === cwd
      ? filterFileEntries(fileIndex.entries, atQueryText)
      : []
  ), [atQueryText, fileIndex, cwd]);

  // When the client index is truncated (repo larger than the index cap),
  // local filtering cannot see deep files, so queries are also ranked
  // server-side against the full listing. Local matches render immediately
  // and are replaced when the (debounced) server result for the current
  // query arrives; stale responses are ignored via the query/cwd tag.
  const needsServerSearch = Boolean(atQueryText && fileIndex?.truncated && fileIndex.cwd === cwd);
  useEffect(() => {
    if (!needsServerSearch || !cwd || !atQueryText) return;
    const fetchCwd = cwd;
    const query = atQueryText;
    const timer = setTimeout(() => {
      fetch(`/api/file-index?cwd=${encodeURIComponent(fetchCwd)}&q=${encodeURIComponent(query)}`)
        .then((res) => {
          if (!res.ok) throw new Error(`file search failed: ${res.status}`);
          return res.json() as Promise<{ matches?: FileIndexEntry[] }>;
        })
        .then((data) => setAtServerResult({ cwd: fetchCwd, query, matches: data.matches ?? [] }))
        .catch(() => {
          // Keep showing local matches; the next keystroke retries.
        });
    }, 150);
    return () => clearTimeout(timer);
  }, [needsServerSearch, atQueryText, cwd]);

  const serverResultInUse = needsServerSearch
    && atServerResult !== null
    && atServerResult.cwd === cwd
    && atServerResult.query === atQueryText;
  const atMatches: FileIndexEntry[] = serverResultInUse ? atServerResult.matches : atLocalMatches;

  // Open/reset the menu whenever the @token appears or changes (mirrors the
  // slash menu: Escape closes it, the next keystroke re-opens it).
  const atTokenKey = atQuery === null ? null : `${atQuery.start}:${atQuery.quoted ? 1 : 0}:${atQuery.query}`;
  useEffect(() => {
    if (atTokenKey === null) {
      setAtMenuOpen(false);
      setAtActiveIndex(0);
      return;
    }
    setAtMenuOpen(true);
    setAtActiveIndex(0);
  }, [atTokenKey]);

  // Fetch the file index when the menu opens. The server caches per cwd for
  // ~10s, so re-opening refreshes cheaply; while typing nothing refetches.
  const atTokenActive = atQuery !== null;
  useEffect(() => {
    if (!atTokenActive || !cwd) return;
    const meta = fileIndexMetaRef.current;
    if (meta && meta.cwd === cwd && Date.now() - meta.fetchedAt < 10_000) return;
    if (fileIndexFetchingRef.current === cwd) return;
    fileIndexFetchingRef.current = cwd;
    const fetchCwd = cwd;
    setFileIndexLoading(true);
    fetch(`/api/file-index?cwd=${encodeURIComponent(fetchCwd)}`)
      .then((res) => {
        if (!res.ok) throw new Error(`file index failed: ${res.status}`);
        return res.json() as Promise<{ files?: string[]; truncated?: boolean }>;
      })
      .then((data) => {
        setFileIndex({ cwd: fetchCwd, entries: buildEntriesFromFiles(data.files ?? []), truncated: !!data.truncated });
        fileIndexMetaRef.current = { cwd: fetchCwd, fetchedAt: Date.now() };
      })
      .catch(() => {
        // Leave any previous index in place; next open retries.
        fileIndexMetaRef.current = null;
      })
      .finally(() => {
        fileIndexFetchingRef.current = null;
        setFileIndexLoading(false);
      });
  }, [atTokenActive, cwd]);

  const applyAtCompletion = useCallback((entry: FileIndexEntry) => {
    if (!atQuery) return;
    const cursor = editorRef.current?.selection().start ?? value.length;
    const before = value.slice(0, atQuery.start);
    let after = value.slice(cursor);
    // Completing inside a quoted token (@"my dir/… with the caret before the
    // closing quote): the replacement carries its own closing quote, so drop
    // the old one right after the caret (mirrors the TUI's applyCompletion).
    if (atQuery.quoted && after.startsWith('"')) {
      after = after.slice(1);
    }
    const end = value.length - after.length;
    if (entry.isDir) {
      const insert = buildAtInsertText(entry.path, true, atQuery.quoted);
      editorRef.current?.replace(atQuery.start, end, textParts(insert.text));
      requestAnimationFrame(() => editorRef.current?.focus(before.length + insert.cursorOffset));
    } else {
      editorRef.current?.replace(atQuery.start, end, [{ type: "file", path: entry.path }, ...textParts(" ")]);
    }
  }, [atQuery, value]);

  useEffect(() => {
    if (atActiveIndex >= atMatches.length) {
      setAtActiveIndex(Math.max(0, atMatches.length - 1));
    }
  }, [atMatches.length, atActiveIndex]);

  useEffect(() => {
    atItemRefs.current.length = atMatches.length;
  }, [atMatches.length]);

  useEffect(() => {
    if (!atMenuOpen) return;
    atItemRefs.current[atActiveIndex]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [atActiveIndex, atMenuOpen]);

  useEffect(() => {
    if (historyActiveIndex >= inputHistory.length) {
      setHistoryActiveIndex(Math.max(0, inputHistory.length - 1));
    }
  }, [inputHistory.length, historyActiveIndex]);

  useEffect(() => {
    historyItemRefs.current.length = inputHistory.length;
  }, [inputHistory.length]);

  useEffect(() => {
    if (!historyMenuOpen) return;
    historyItemRefs.current[historyActiveIndex]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [historyActiveIndex, historyMenuOpen]);

  const applyHistoryInput = useCallback((text: string) => {
    const restored = restoreComposerText(text);
    setParts(restored);
    setHistoryMenuOpen(false);
    setHistoryActiveIndex(0);
    setAtQuery(null);
    requestAnimationFrame(() => editorRef.current?.focus(composerText(restored).length));
  }, []);

  const applySlashCommand = useCallback((command: SlashCommandPaletteItem) => {
    if (!slashToken) return;
    const replacement: ComposerPart[] = command.source === "skill"
      ? [{ type: "skill", name: command.name.replace(/^skills?:/i, "") }, ...textParts(" ")]
      : textParts(`/${command.name} `);
    editorRef.current?.replace(slashToken.start, slashToken.end, replacement);
    setSlashMenuOpen(false);
    setSlashActiveIndex(0);
  }, [slashToken]);

  const sendQueued = useCallback(async (mode: "steer" | "followup") => {
    const msg = serializeComposer(parts).trim();
    if (!msg && !attachedImages.length) return;
    if (attachedImages.length || hasQueuedMessage || queueSubmitRef.current) return;
    const streamingBehavior = mode === "steer" ? "steer" : "followUp";
    const handler = !skillParts && msg.startsWith("/") && onPromptWithStreamingBehavior
      ? () => onPromptWithStreamingBehavior(msg, streamingBehavior)
      : mode === "steer" && onSteer
        ? () => onSteer(msg, undefined, skillParts)
        : onFollowUp
          ? () => onFollowUp(msg, undefined, skillParts)
          : null;
    if (!handler) return;

    queueSubmitRef.current = true;
    setQueueSubmitting(true);
    onAudioUnlock?.();
    clearInput();
    try {
      await handler();
    } catch {
      queueSubmitRef.current = false;
      setQueueSubmitting(false);
      restoreInput(parts, []);
      return;
    }

    // queue_update is authoritative. Keep the synchronous guard until that
    // event arrives; the timeout only recovers from a failed/missed request.
    if (queueSubmitTimeoutRef.current) clearTimeout(queueSubmitTimeoutRef.current);
    queueSubmitTimeoutRef.current = setTimeout(() => {
      queueSubmitRef.current = false;
      setQueueSubmitting(false);
      queueSubmitTimeoutRef.current = null;
    }, 5000);
  }, [parts, skillParts, attachedImages, hasQueuedMessage, onPromptWithStreamingBehavior, onSteer, onFollowUp, clearInput, restoreInput, onAudioUnlock]);

  const getNextSlashIndex = useCallback((direction: "up" | "down" | "left" | "right") => {
    const lastIndex = filteredSlashCommands.length - 1;
    if (lastIndex < 0) return 0;

    if (direction === "left") return Math.max(0, slashActiveIndex - 1);
    if (direction === "right") return Math.min(lastIndex, slashActiveIndex + 1);

    const currentNode = slashItemRefs.current[slashActiveIndex];
    if (!currentNode) {
      return direction === "down"
        ? Math.min(lastIndex, slashActiveIndex + 1)
        : Math.max(0, slashActiveIndex - 1);
    }

    const currentRect = currentNode.getBoundingClientRect();
    const currentX = currentRect.left + currentRect.width / 2;
    const currentY = currentRect.top + currentRect.height / 2;
    let bestIndex = -1;
    let bestScore = Number.POSITIVE_INFINITY;

    for (let index = 0; index <= lastIndex; index += 1) {
      if (index === slashActiveIndex) continue;
      const node = slashItemRefs.current[index];
      if (!node) continue;
      const rect = node.getBoundingClientRect();
      const candidateY = rect.top + rect.height / 2;
      const verticalDelta = candidateY - currentY;
      if (direction === "down" ? verticalDelta <= 4 : verticalDelta >= -4) continue;

      const candidateX = rect.left + rect.width / 2;
      const score = Math.abs(verticalDelta) * 1000 + Math.abs(candidateX - currentX);
      if (score < bestScore) {
        bestIndex = index;
        bestScore = score;
      }
    }

    if (bestIndex >= 0) return bestIndex;
    return direction === "down"
      ? Math.min(lastIndex, slashActiveIndex + 1)
      : Math.max(0, slashActiveIndex - 1);
  }, [filteredSlashCommands.length, slashActiveIndex]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      const nativeEvent = e.nativeEvent;
      const recentlyComposed = Date.now() - lastCompositionEndAtRef.current < COMPOSITION_END_ENTER_GRACE_MS;
      const isComposing =
        isComposingRef.current ||
        nativeEvent.isComposing ||
        nativeEvent.keyCode === 229;

      if (e.key === "Enter" && !e.shiftKey && (isComposing || recentlyComposed)) {
        if (recentlyComposed) e.preventDefault();
        return;
      }

      if (historyMenuOpen && !isComposing) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setHistoryActiveIndex((i) => Math.min(Math.max(0, inputHistory.length - 1), i + 1));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setHistoryActiveIndex((i) => Math.max(0, i - 1));
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setHistoryMenuOpen(false);
          return;
        }
        if ((e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) && inputHistory[historyActiveIndex]) {
          e.preventDefault();
          applyHistoryInput(inputHistory[historyActiveIndex]);
          return;
        }
      }

      if (slashMenuOpen && slashQuery !== null && !isComposing) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSlashActiveIndex(getNextSlashIndex("down"));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setSlashActiveIndex(getNextSlashIndex("up"));
          return;
        }
        if (e.key === "ArrowRight") {
          e.preventDefault();
          setSlashActiveIndex(getNextSlashIndex("right"));
          return;
        }
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          setSlashActiveIndex(getNextSlashIndex("left"));
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setSlashMenuOpen(false);
          return;
        }
        if ((e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) && filteredSlashCommands[slashActiveIndex]) {
          e.preventDefault();
          applySlashCommand(filteredSlashCommands[slashActiveIndex]);
          return;
        }
      }

      // @ file menu — skip while composing so IME candidate navigation
      // (arrows/Enter/Tab) is never intercepted.
      if (atMenuOpen && atQuery !== null && !isComposing) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setAtActiveIndex((i) => Math.min(Math.max(0, atMatches.length - 1), i + 1));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setAtActiveIndex((i) => Math.max(0, i - 1));
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setAtMenuOpen(false);
          return;
        }
        if ((e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) && atMatches[atActiveIndex]) {
          e.preventDefault();
          applyAtCompletion(atMatches[atActiveIndex]);
          return;
        }
      }

      if (e.key === "ArrowUp" && !isComposing && !isStreaming && inputHistory.length > 0 && value.trim().length === 0) {
        e.preventDefault();
        setSlashMenuOpen(false);
        setAtMenuOpen(false);
        setHistoryActiveIndex(inputHistory.length - 1);
        setHistoryMenuOpen(true);
        return;
      }

      // Esc stops the agent when no slash/@/history menu or IME composition is active.
      if (e.key === "Escape" && !isComposing && isStreaming && onAbort) {
        e.preventDefault();
        onAbort();
        return;
      }

      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        // Pi has a separate compaction operation, not an active agent turn.
        // Keep Enter from submitting a normal prompt until it completes.
        if (isCompacting) return;
        if (isStreaming && (onSteer || onFollowUp)) {
          if (hasQueuedMessage) return;
          if (e.altKey && onFollowUp) sendQueued("followup");
          else sendQueued(onSteer ? "steer" : "followup");
        } else {
          handleSend();
        }
      }
    },
    [isStreaming, isCompacting, onSteer, onFollowUp, onAbort, hasQueuedMessage, slashMenuOpen, slashQuery, filteredSlashCommands, slashActiveIndex, applySlashCommand, sendQueued, handleSend, getNextSlashIndex, atMenuOpen, atQuery, atMatches, atActiveIndex, applyAtCompletion, historyMenuOpen, inputHistory, historyActiveIndex, applyHistoryInput, value]
  );

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = Array.from(e.clipboardData?.items ?? []);
    const imageItems = items.filter((item) => item.type.startsWith("image/"));
    if (!imageItems.length) return;
    e.preventDefault();
    const files = imageItems.map((item) => item.getAsFile()).filter((f): f is File => f !== null);
    processImageFiles(files);
  }, [processImageFiles]);

  useEffect(() => {
    if (slashQuery === null) {
      setSlashMenuOpen(false);
      setSlashActiveIndex(0);
      slashCommandsRequestedRef.current = false;
      return;
    }
    setSlashMenuOpen(true);
    setSlashActiveIndex(0);
    if (!slashCommandsRequestedRef.current && onLoadSlashCommands) {
      slashCommandsRequestedRef.current = true;
      Promise.resolve(onLoadSlashCommands()).catch(() => {
        slashCommandsRequestedRef.current = false;
      });
    }
  }, [slashQuery, onLoadSlashCommands]);

  useEffect(() => {
    if (slashActiveIndex >= filteredSlashCommands.length) {
      setSlashActiveIndex(Math.max(0, filteredSlashCommands.length - 1));
    }
  }, [filteredSlashCommands.length, slashActiveIndex]);

  useEffect(() => {
    slashItemRefs.current.length = filteredSlashCommands.length;
  }, [filteredSlashCommands.length]);

  useEffect(() => {
    if (!slashMenuOpen) return;
    slashItemRefs.current[slashActiveIndex]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [slashActiveIndex, slashMenuOpen]);

  const compactSavedTokens = compactResult
    ? Math.max(0, compactResult.tokensBefore - compactResult.estimatedTokensAfter)
    : 0;
  const compactResultText = compactResult
    ? `${compactResult.reason && compactResult.reason !== "manual" ? `${compactResult.reason[0].toUpperCase()}${compactResult.reason.slice(1)} ` : t("chat.compacted")} ${formatTokenCount(compactResult.tokensBefore)} -> ${formatTokenCount(compactResult.estimatedTokensAfter)} tokens (${t("chat.tokensSaved", { saved: formatTokenCount(compactSavedTokens) })})`
    : null;
  // 点击编辑器以外区域时关闭历史菜单。
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (historyMenuRef.current && !historyMenuRef.current.contains(e.target as Node) && !editorRef.current?.contains(e.target as Node)) {
        setHistoryMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);


  return (
    <div
      className="chat-content-gutter chat-composer"
      style={{
        flexShrink: 0,
        paddingBottom: 8,
        background: "transparent",
      }}
    >
      <div className="chat-content-column">
        <ModelErrorBanner error={modelError} />
        {/* Retry banner */}
        {retryInfo && (
          <div style={{
            marginBottom: 8, padding: "5px 10px",
            background: "rgba(234,179,8,0.08)", border: "1px solid rgba(234,179,8,0.25)",
            borderRadius: 6, fontSize: 12, color: "rgba(180,130,0,0.9)",
            display: "flex", alignItems: "center", gap: 6,
          }}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
              <path d="M3 3v5h5" />
            </svg>
             {t("chat.retrying", { attempt: retryInfo.attempt, max: retryInfo.maxAttempts })}{retryInfo.errorMessage && <span style={{ opacity: 0.7, marginLeft: 4 }}>— {retryInfo.errorMessage}</span>}
          </div>
        )}
        {compactResultText && (
          <div style={{
            marginBottom: 8, padding: "5px 10px",
            background: "rgba(16,185,129,0.08)", border: "1px solid rgba(16,185,129,0.24)",
            borderRadius: 6, fontSize: 12, color: "rgba(5,150,105,0.95)",
            display: "flex", alignItems: "center", gap: 6,
          }}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <polyline points="20 6 9 17 4 12" />
            </svg>
            {compactResultText}
          </div>
        )}
        {/* Image previews */}
        {attachedImages.length > 0 && (
          <div style={{ display: "flex", gap: 6, marginBottom: 6, flexWrap: "wrap" }}>
            {attachedImages.map((img, i) => (
              <div key={i} style={{ position: "relative", flexShrink: 0 }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={img.previewUrl}
                  alt=""
                  style={{ width: 56, height: 56, objectFit: "cover", borderRadius: 6, border: "1px solid var(--border)", display: "block" }}
                />
                <button
                  onClick={() => removeImage(i)}
                  style={{
                    position: "absolute", top: -4, right: -4,
                    width: 16, height: 16, borderRadius: "50%",
                    background: "var(--bg-panel)", border: "1px solid var(--border)",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    cursor: "pointer", padding: 0, color: "var(--text-muted)",
                  }}
                >
                  <svg width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                    <line x1="1" y1="1" x2="7" y2="7" /><line x1="7" y1="1" x2="1" y2="7" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Main input */}
        {projectPicker && (
          <NewTaskProjectPicker
            resetKey={projectPicker.resetKey}
            selectedCwd={projectPicker.selectedCwd}
            onSelect={projectPicker.onSelect}
            onClear={projectPicker.onClear}
            onFocusComposer={focusComposer}
          />
        )}
        <div style={{ position: "relative", isolation: "isolate" }}>
          {/* Absolute overlay: queue changes never alter composer/page height. */}
          {queuedEntries.length > 0 && (
            <div style={{
              position: "absolute",
              left: 14,
              right: 14,
              bottom: "calc(100% - 9px)",
              zIndex: 0,
              display: "flex",
              flexDirection: "column",
              gap: 6,
            }}>
              {queuedEntries.map((entry, index) => {
                const status = entry.kind === "steer" ? t("chat.steer") : t("chat.followUp");
                const busy = queueAction !== null;
                return (
                  <div
                    key={`${entry.kind}-${index}-${entry.text}`}
                    className="composer-floating-surface"
                    aria-busy={busy}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      width: "100%",
                      gap: 10,
                      minHeight: 46,
                      padding: "9px 11px 15px 12px",
                      borderRadius: "16px 16px 8px 8px",
                      color: "var(--text)",
                    }}
                  >
                    <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, flex: 1 }}>
                      <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="var(--text-dim)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
                        <path d="M5 4v7a3 3 0 0 0 3 3h7" /><path d="m12 11 3 3-3 3" />
                      </svg>
                      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12.5, lineHeight: 1.45 }}>
                        {entry.text}
                      </span>
                    </span>
                    <span style={{ flexShrink: 0, color: "var(--text-muted)", fontSize: 11.5, whiteSpace: "nowrap" }}>
                      {status}
                    </span>
                    <span style={{ display: "flex", alignItems: "center", gap: 1, flexShrink: 0 }}>
                      <button
                        type="button"
                        onClick={() => void runQueueAction("edit")}
                        disabled={busy || !onRecallQueue}
                        title={t("chat.editQueued")}
                        aria-label={t("chat.editQueued")}
                        style={queueIconButtonStyle}
                      >
                        {queueAction === "edit" ? (
                          <span className="animate-spin" style={{ width: 12, height: 12, border: "1.5px solid currentColor", borderRightColor: "transparent", borderRadius: "50%" }} />
                        ) : (
                          <svg width="13" height="13" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <path d="M4 14.5 3.5 17l2.5-.5L15.5 7 13 4.5Z" /><path d="m11.8 5.7 2.5 2.5" />
                          </svg>
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={() => void runQueueAction("delete")}
                        disabled={busy || !onDeleteQueue}
                        title={t("chat.deleteQueued")}
                        aria-label={t("chat.deleteQueued")}
                        style={queueIconButtonStyle}
                      >
                        {queueAction === "delete" ? (
                          <span className="animate-spin" style={{ width: 12, height: 12, border: "1.5px solid currentColor", borderRightColor: "transparent", borderRadius: "50%" }} />
                        ) : (
                          <svg width="13" height="13" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <path d="M4 6h12" /><path d="m8 3h4l1 3H7Z" /><path d="m6 6 .7 10h6.6L14 6" />
                          </svg>
                        )}
                      </button>
                    </span>
                  </div>
                );
              })}
            </div>
          )}
          {historyMenuOpen && inputHistory.length > 0 && (
            <div
              ref={historyMenuRef}
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                bottom: "calc(100% + 8px)",
                zIndex: 120,
                background: "var(--bg)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                boxShadow: "0 -6px 20px rgba(0,0,0,0.12)",
                overflow: "hidden",
                maxHeight: "min(44vh, 360px)",
              }}
            >
              <div
                title="Input history"
                style={{
                  height: 30,
                  padding: "0 10px",
                  borderBottom: "1px solid var(--border)",
                  display: "flex",
                  alignItems: "center",
                  color: "var(--text-dim)",
                }}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M3 12a9 9 0 1 0 3-6.7" />
                  <path d="M3 4v5h5" />
                  <path d="M12 7v5l3 2" />
                </svg>
              </div>
              <div style={{ maxHeight: "calc(min(44vh, 360px) - 31px)", overflowY: "auto", padding: 4 }}>
                {inputHistory.map((item, index) => {
                  const active = index === historyActiveIndex;
                  return (
                    <button
                      key={`${index}:${item}`}
                      ref={(node) => {
                        historyItemRefs.current[index] = node;
                      }}
                      type="button"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        applyHistoryInput(item);
                      }}
                      onMouseEnter={() => setHistoryActiveIndex(index)}
                      style={{
                        width: "100%",
                        display: "flex",
                        alignItems: "flex-start",
                        gap: 8,
                        padding: "7px 8px",
                        border: "none",
                        borderRadius: 6,
                        background: active ? "var(--bg-selected)" : "none",
                        color: "var(--text)",
                        cursor: "pointer",
                        textAlign: "left",
                        fontSize: 12.5,
                        lineHeight: 1.45,
                      }}
                    >
                      <span style={{ flexShrink: 0, fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-dim)", paddingTop: 1 }}>
                        {index + 1}
                      </span>
                      <span style={{ minWidth: 0, display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: 2, overflow: "hidden", overflowWrap: "anywhere" }}>
                        {item}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          {slashMenuOpen && slashQuery !== null && (
            <div
              role="listbox"
              aria-label={t("chat.slashCommands", { label: slashCommandCountLabel })}
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                bottom: "calc(100% + 8px)",
                zIndex: 120,
                background: "var(--bg)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                boxShadow: "0 -6px 20px rgba(0,0,0,0.12)",
                overflow: "hidden",
                maxHeight: "min(48vh, 400px)",
              }}
            >
              <div style={{ maxHeight: "min(48vh, 400px)", overflowY: "auto", padding: 4 }}>
                {!slashCommandsLoading && filteredSlashCommands.length === 0 ? (
                  <div style={{ padding: "6px 8px", fontSize: 12, color: "var(--text-dim)" }}>
                    {t("chat.noCommands")}
                  </div>
                ) : (
                  filteredSlashCommands.map((command, index) => {
                    const active = index === slashActiveIndex;
                    const startsSkillGroup = command.source === "skill" && filteredSlashCommands[index - 1]?.source !== "skill";
                    return (
                      <React.Fragment key={`${command.source}:${command.name}`}>
                        {startsSkillGroup && (
                          <div style={{ padding: "7px 8px 4px", color: "var(--text-muted)", fontSize: 12, fontWeight: 500 }}>
                            {t("chat.skills")}
                          </div>
                        )}
                        <button
                          ref={(node) => {
                            slashItemRefs.current[index] = node;
                          }}
                          type="button"
                          role="option"
                          aria-selected={active}
                          onMouseDown={(e) => {
                            e.preventDefault();
                            applySlashCommand(command);
                          }}
                          onMouseEnter={() => setSlashActiveIndex(index)}
                          style={{
                            width: "100%",
                            minWidth: 0,
                            display: "grid",
                            gridTemplateColumns: "14px minmax(88px, auto) minmax(0, 1fr)",
                            alignItems: "center",
                            columnGap: 8,
                            padding: "6px 8px",
                            border: "none",
                            borderRadius: 6,
                            background: active ? "var(--bg-selected)" : "none",
                            color: "var(--text)",
                            cursor: "pointer",
                            textAlign: "left",
                            fontSize: 12.5,
                            lineHeight: 1.45,
                          }}
                        >
                          <span style={{ color: active ? "var(--accent)" : "var(--text-muted)", display: "flex", alignItems: "center" }}>
                            <SlashCommandIcon command={command} />
                          </span>
                          <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {getSlashCommandLabel(command)}
                          </span>
                          <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text-dim)", textAlign: "right" }}>
                            {getSlashDescription(command, t)}
                          </span>
                        </button>
                      </React.Fragment>
                    );
                  })
                )}
              </div>
            </div>
          )}
          {atMenuOpen && atQuery !== null && (() => {
            const indexLoading = fileIndexLoading && (!fileIndex || fileIndex.cwd !== cwd);
             const matchCountLabel = atMatches.length === 1 ? t("chat.match") : t("chat.matches", { count: atMatches.length });
            // With a truncated index, local results are provisional — the
            // debounced server search over the full listing replaces them.
            const truncatedHint = fileIndex?.truncated && !serverResultInUse
               ? (atQuery.query ? t("chat.searchingAll") : t("chat.indexTruncated"))
              : "";
            return (
              <div
                style={{
                  position: "absolute",
                  left: 0,
                  right: 0,
                  bottom: "calc(100% + 8px)",
                  zIndex: 120,
                  background: "var(--bg)",
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  boxShadow: "0 -6px 20px rgba(0,0,0,0.12)",
                  overflow: "hidden",
                  maxHeight: "min(48vh, 400px)",
                }}
              >
                <div
                  style={{
                    padding: "8px 10px",
                    borderBottom: "1px solid var(--border)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 8,
                    fontSize: 11,
                    color: "var(--text-dim)",
                  }}
                >
                  <span>
                    {indexLoading
                       ? t("chat.loadingFiles")
                       : t("chat.files", { label: matchCountLabel, hint: truncatedHint })}
                  </span>
                   <span style={{ fontFamily: "var(--font-mono)" }}>{t("chat.tabEnter")}</span>
                </div>
                <div style={{ maxHeight: "calc(min(48vh, 400px) - 34px)", overflowY: "auto", padding: 4 }}>
                  {!indexLoading && atMatches.length === 0 ? (
                    <div style={{ padding: "6px 8px", fontSize: 12, color: "var(--text-dim)" }}>
                       {needsServerSearch && !serverResultInUse ? t("chat.searching") : t("chat.noMatchingFiles")}
                    </div>
                  ) : (
                    atMatches.map((entry, index) => {
                      const active = index === atActiveIndex;
                      const name = entry.path.split("/").pop() ?? entry.path;
                      const dirPrefix = entry.path.slice(0, entry.path.length - name.length);
                      return (
                        <button
                          key={`${entry.isDir ? "d" : "f"}:${entry.path}`}
                          ref={(node) => {
                            atItemRefs.current[index] = node;
                          }}
                          type="button"
                          onMouseDown={(e) => {
                            e.preventDefault();
                            applyAtCompletion(entry);
                          }}
                          onMouseEnter={() => setAtActiveIndex(index)}
                          style={{
                            width: "100%",
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                            padding: "6px 8px",
                            border: "none",
                            borderRadius: 6,
                            background: active ? "var(--bg-selected)" : "none",
                            color: "var(--text)",
                            cursor: "pointer",
                            textAlign: "left",
                            fontSize: 12.5,
                            fontFamily: "var(--font-mono)",
                          }}
                        >
                          <span style={{ flexShrink: 0, display: "flex", alignItems: "center" }}>
                            {entry.isDir ? <FolderIcon size={14} /> : getFileIcon(name, 14)}
                          </span>
                          <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {dirPrefix && <span style={{ color: "var(--text-dim)" }}>{dirPrefix}</span>}
                            {name}
                            {entry.isDir && <span style={{ color: "var(--text-dim)" }}>/</span>}
                          </span>
                        </button>
                      );
                    })
                  )}
                </div>
              </div>
            );
          })()}
          <div
            className="composer-shell"
            onMouseDown={(event) => {
              if (!(event.target instanceof Element) || event.target.closest('button, a, input, textarea, select, label, summary, [role="button"], [role="menuitem"], [role="option"], [tabindex], [contenteditable]')) return;
              event.preventDefault();
              focusComposer();
            }}
          >
          <div className="composer-shell-editor">
          <ComposerEditor
            key={draftKey}
            ref={editorRef}
            parts={parts}
            onChange={(next) => {
              setParts(next);
              setHistoryMenuOpen(false);
            }}
            onSelectionChange={updateAtQuery}
            onKeyDown={handleKeyDown}
            onCompositionStart={() => {
              isComposingRef.current = true;
            }}
            onCompositionEnd={() => {
              isComposingRef.current = false;
              lastCompositionEndAtRef.current = Date.now();
              updateAtQuery(completionText(partsRef.current), editorRef.current?.selection().start ?? 0);
            }}
            onPaste={handlePaste}
            placeholder={
              isCompacting
                ? t("chat.compacting")
                : isStreaming && (onSteer || onFollowUp)
                  ? t("chat.steerPlaceholder")
                  : isStreaming ? t("chat.agentPlaceholder")
                  : t("chat.messagePlaceholder")
            }
          />
          </div>
          <div className="composer-shell-footer">
            <div className="composer-shell-permission"><PermissionPicker /></div>
            <div className="composer-shell-actions">
              <ContextRing usage={contextUsage} />
              <ModelThinkingPicker
                model={model}
                isAutoModelSelection={isAutoModelSelection}
                modelNames={modelNames}
                modelList={modelList}
                modelError={modelError}
                onModelChange={onModelChange}
                thinkingLevel={thinkingLevel}
                availableThinkingLevels={availableThinkingLevels}
                onThinkingLevelChange={onThinkingLevelChange}
                disabled={isStreaming}
              />
          <button
            type="button"
            className="composer-send-button"
            onClick={willSendSteer ? () => sendQueued("steer") : isStreaming ? onAbort : handleSend}
            disabled={sendBlocked}
            title={willSendSteer ? `${t("chat.steer")} · Enter` : isCompacting ? t("chat.stopCompaction") : isStreaming ? t("chat.stopAgent") : t("chat.send")}
            aria-label={willSendSteer ? t("chat.steer") : isCompacting ? t("chat.stopCompaction") : isStreaming ? t("chat.stopAgent") : t("chat.send")}
          >
            {isStreaming && !willSendSteer ? (
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                <rect x="2" y="2" width="8" height="8" rx="1.5" fill="currentColor" />
              </svg>
            ) : (
              <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <line x1="7.5" y1="12.5" x2="7.5" y2="2.5" />
                <polyline points="3.5 6.5 7.5 2.5 11.5 6.5" />
              </svg>
            )}
          </button>
            </div>
          </div>
          </div>
        </div>

        {/* Bash mode status label */}
        {bashMode && (
          <div className="text-xs px-2 py-1" style={{ color: bashExcluded ? "var(--text-muted)" : "var(--accent)", marginTop: 4 }}>
             {t("chat.shell")} · {bashExcluded ? t("chat.outputLocal") : t("chat.outputModel")}
          </div>
        )}

      </div>
    </div>
  );
});
