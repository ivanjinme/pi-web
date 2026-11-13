"use client";

import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ThinkingLevelOption } from "@/hooks/useAgentSession";
import { useI18n } from "@/hooks/useI18n";

export interface ModelThinkingPickerProps {
  model?: { provider: string; modelId: string } | null;
  isAutoModelSelection?: boolean;
  modelNames?: Record<string, string>;
  modelList?: { id: string; name: string; provider: string }[];
  modelError?: string | null;
  onModelChange?: (provider: string, modelId: string) => void;
  thinkingLevel?: ThinkingLevelOption | null;
  availableThinkingLevels?: ThinkingLevel[] | null;
  onThinkingLevelChange?: (level: ThinkingLevelOption) => void;
  disabled?: boolean;
}

interface ModelOption {
  provider: string;
  modelId: string;
  name: string;
}

const MODEL_OPTION_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const modelKey = (model: ModelOption) => JSON.stringify([model.provider, model.modelId]);

function compareModelOptions(a: ModelOption, b: ModelOption): number {
  return MODEL_OPTION_COLLATOR.compare(a.name || a.modelId, b.name || b.modelId)
    || MODEL_OPTION_COLLATOR.compare(a.provider, b.provider)
    || MODEL_OPTION_COLLATOR.compare(a.modelId, b.modelId);
}

type PopoverAlignment = "start" | "center" | "end";

function popoverPosition(anchor: HTMLButtonElement, width: number, alignment: PopoverAlignment): CSSProperties {
  const rect = anchor.getBoundingClientRect();
  const viewport = window.visualViewport;
  const left = viewport?.offsetLeft ?? 0;
  const top = viewport?.offsetTop ?? 0;
  const viewportWidth = viewport?.width ?? window.innerWidth;
  const panelWidth = Math.min(width, viewportWidth - 16);
  const panelLeft = alignment === "start" ? rect.left : alignment === "center" ? rect.left + (rect.width - panelWidth) / 2 : rect.right - panelWidth;
  return {
    width: panelWidth,
    left: Math.max(left + 8, Math.min(panelLeft, left + viewportWidth - panelWidth - 8)),
    bottom: window.innerHeight - Math.max(top + 14, rect.top) + 6,
    maxHeight: Math.max(0, rect.top - top - 14),
  };
}

function useUpwardPopover(width: number, focusSelector?: string, alignment: PopoverAlignment = "end") {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<CSSProperties>({});
  const anchorRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  function show() {
    if (anchorRef.current) setPosition(popoverPosition(anchorRef.current, width, alignment));
    setOpen(true);
  }

  useEffect(() => {
    if (!open) return;
    const dismissOutside = (event: Event) => {
      const target = event.target as Node | null;
      if (target && !anchorRef.current?.contains(target) && !panelRef.current?.contains(target)) setOpen(false);
    };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      // 弹层先消费 Escape，避免同一次按键触发全局停止任务。
      event.stopPropagation();
      setOpen(false);
      anchorRef.current?.focus();
    };
    const reposition = () => {
      if (anchorRef.current) setPosition(popoverPosition(anchorRef.current, width, alignment));
    };
    const frame = requestAnimationFrame(() => {
      if (focusSelector) panelRef.current?.querySelector<HTMLElement>(focusSelector)?.focus();
    });
    document.addEventListener("pointerdown", dismissOutside);
    document.addEventListener("focusin", dismissOutside);
    document.addEventListener("keydown", escape, true);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    window.visualViewport?.addEventListener("resize", reposition);
    window.visualViewport?.addEventListener("scroll", reposition);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", dismissOutside);
      document.removeEventListener("focusin", dismissOutside);
      document.removeEventListener("keydown", escape, true);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
      window.visualViewport?.removeEventListener("resize", reposition);
      window.visualViewport?.removeEventListener("scroll", reposition);
    };
  }, [open, width, focusSelector, alignment]);

  return { open, setOpen, show, position, anchorRef, panelRef };
}

function Chevron({ open }: { open: boolean }) {
  return <svg className="composer-control-chevron" data-open={open} width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>;
}

function Check() {
  return <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m3 8 3 3 7-7" /></svg>;
}

function ThinkingSlider({ level, supported, onChange, disabled }: {
  level?: ThinkingLevelOption | null;
  supported?: ThinkingLevel[] | null;
  onChange?: (level: ThinkingLevelOption) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const levels = [...new Set(supported ?? [])];
  const index = level == null ? -1 : levels.indexOf(level);
  const locked = disabled || !onChange || levels.length <= 1 || index < 0;
  const [dragging, setDragging] = useState(false);
  const originX = useRef<number | null>(null);
  const position = (i: number) => levels.length <= 1 ? 0.5 : i / (levels.length - 1);
  const center = (i: number) => `calc((100% - 26px) * ${position(i)} + 13px)`;

  function release() {
    originX.current = null;
    setDragging(false);
  }

  return (
    <div className="composer-thinking" data-locked={locked}>
      <div className="composer-thinking-heading"><span>{t("chat.thinkingDepth")}</span><span>{level ?? "—"}</span></div>
      {index < 0 && levels.length > 0 && (
        <div className="composer-thinking-choices" role="group" aria-label={t("chat.thinkingDepth")}>
          {/* 换模型后旧档位可能不再支持；保留明确选择新档位的入口。 */}
          {levels.map((item) => <button key={item} type="button" disabled={disabled || !onChange} onClick={() => onChange?.(item)}>{item}</button>)}
        </div>
      )}
      <div className="composer-thinking-slider" data-dragging={dragging}>
        <div className="composer-thinking-track" />
        {index >= 0 && levels.length > 1 && <div className="composer-thinking-fill" style={{ "--fill-width": index === 0 ? "0px" : center(index) } as CSSProperties} />}
        {levels.map((item, i) => <span key={item} className="composer-thinking-tick" data-passed={index >= 0 && i <= index} style={{ left: center(i) }} />)}
        {/* 未知档位不假定为首档；只有服务端明确支持的档位可选。 */}
        {levels.length > 1 && index >= 0 && <>
          <input
            type="range" className="composer-thinking-range" min={0} max={levels.length - 1} step={1} value={index}
            disabled={locked} aria-label={t("chat.thinkingDepth")} aria-valuetext={level ?? "—"}
            onChange={(event) => onChange?.(levels[Number(event.target.value)])}
            onPointerDown={(event) => { originX.current = event.clientX; event.currentTarget.setPointerCapture(event.pointerId); }}
            onPointerMove={(event) => { if (originX.current !== null && Math.abs(event.clientX - originX.current) > 3) setDragging(true); }}
            onPointerUp={release} onPointerCancel={release} onLostPointerCapture={release}
          />
          <div className="composer-thinking-knob-rail" style={{ "--position": position(index) } as CSSProperties}><div className="composer-thinking-knob" /></div>
        </>}
      </div>
    </div>
  );
}

export function ModelThinkingPicker({ model, isAutoModelSelection, modelNames, modelList, modelError, onModelChange, thinkingLevel, availableThinkingLevels, onThinkingLevelChange, disabled }: ModelThinkingPickerProps) {
  const { t } = useI18n();
  const popup = useUpwardPopover(288, "input[type=search]");
  const id = useId();
  const [query, setQuery] = useState("");
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const options = useMemo(() => {
    const items: ModelOption[] = modelList?.length
      ? modelList.map((item) => ({ provider: item.provider, modelId: item.id, name: item.name }))
      : Object.entries(modelNames ?? {}).map(([modelId, name]) => ({ provider: model?.provider ?? "unknown", modelId, name }));
    return items.sort(compareModelOptions);
  }, [modelList, modelNames, model?.provider]);
  const groups = useMemo(() => {
    const result = new Map<string, ModelOption[]>();
    const terms = query.trim().toLowerCase().split(/\s+/);
    for (const option of options) {
      const haystack = `${option.provider} ${option.name} ${option.modelId}`.toLowerCase();
      if (!terms.every((term) => haystack.includes(term))) continue;
      const group = result.get(option.provider) ?? [];
      group.push(option);
      result.set(option.provider, group);
    }
    return [...result].map(([provider, items]) => ({ provider, items }));
  }, [options, query]);
  const flat = groups.flatMap((group) => group.items);
  const selectedKey = model ? JSON.stringify([model.provider, model.modelId]) : null;
  const activeIndex = flat.findIndex((option) => modelKey(option) === (activeKey ?? selectedKey));
  const highlightedIndex = activeIndex >= 0 ? activeIndex : flat.length ? 0 : -1;
  const currentName = model ? options.find((option) => modelKey(option) === selectedKey)?.name || model.modelId : null;
  const isOpen = popup.open && !disabled;

  useEffect(() => {
    if (isOpen && highlightedIndex >= 0) document.getElementById(`${id}-option-${highlightedIndex}`)?.scrollIntoView?.({ block: "nearest" });
  }, [isOpen, id, highlightedIndex]);

  function show() {
    setQuery("");
    setActiveKey(null);
    popup.show();
  }

  function select(option: ModelOption) {
    if (!disabled && (modelKey(option) !== selectedKey || isAutoModelSelection)) onModelChange?.(option.provider, option.modelId);
  }

  function navigate(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!flat.length) return;
      const next = (highlightedIndex + (event.key === "ArrowDown" ? 1 : -1) + flat.length) % flat.length;
      setActiveKey(modelKey(flat[next]));
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (flat[highlightedIndex]) select(flat[highlightedIndex]);
    }
  }

  return <>
    <button
      ref={popup.anchorRef} type="button" className="composer-control-chip composer-model-chip" disabled={disabled}
      aria-label={t("chat.selectModel")} aria-haspopup="dialog" aria-expanded={isOpen} aria-controls={isOpen ? id : undefined}
      title={options.length ? modelError || t("chat.selectModel") : t("chat.noAvailableModels")}
      onClick={() => isOpen ? popup.setOpen(false) : show()}
      onKeyDown={(event) => { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); show(); } }}
    >
      <span className="composer-control-truncate">{currentName ?? (options.length ? t("chat.selectModel") : t("chat.noModels"))}</span>
      <span className="composer-model-depth">· {thinkingLevel ?? "—"}</span><Chevron open={isOpen} />
    </button>
    {isOpen && createPortal(
      <div ref={popup.panelRef} id={id} role="dialog" aria-label={t("chat.selectModel")} className="composer-control-popover composer-model-popover" style={popup.position}>
        <div className="composer-model-search">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><circle cx="6.5" cy="6.5" r="4" /><path d="m10 10 3.5 3.5" /></svg>
          <input type="search" role="combobox" value={query} placeholder={t("chat.modelSearch")} aria-label={t("chat.modelSearch")} aria-expanded="true" aria-autocomplete="list" aria-controls={`${id}-list`} aria-activedescendant={highlightedIndex >= 0 ? `${id}-option-${highlightedIndex}` : undefined} onChange={(event) => { setQuery(event.target.value); setActiveKey(null); }} onKeyDown={navigate} />
        </div>
        <div className="composer-control-rule" />
        <div className="composer-model-list" id={`${id}-list`} role="listbox" aria-label={t("chat.selectModel")}>
          {!flat.length && <div className="composer-model-empty">{query.trim() ? t("chat.noMatchingModels") : t("chat.noAvailableModels")}</div>}
          {groups.map((group) => <div key={group.provider} role="group" aria-label={group.provider}>
            <div className="composer-model-provider">{group.provider}</div>
            {group.items.map((option) => {
              const key = modelKey(option);
              const index = flat.indexOf(option);
              return <button key={key} id={`${id}-option-${index}`} type="button" role="option" aria-selected={key === selectedKey} tabIndex={-1} disabled={!onModelChange} className="composer-control-option" data-active={index === highlightedIndex} title={option.name || option.modelId} onMouseEnter={() => setActiveKey(key)} onMouseDown={(event) => event.preventDefault()} onClick={() => select(option)}>
                <span className="composer-control-truncate">{option.name || option.modelId}</span>{key === selectedKey && <Check />}
              </button>;
            })}
          </div>)}
        </div>
        <div className="composer-control-rule" />
        <ThinkingSlider level={thinkingLevel} supported={availableThinkingLevels} onChange={onThinkingLevelChange} disabled={disabled} />
      </div>, document.body,
    )}
  </>;
}

function PermissionIcon({ fullAccess }: { fullAccess: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {fullAccess ? <><path d="m10 2.5 8 14H2Z" /><path d="M10 7v4.5M10 14h.01" /></> : <path d="m10 2 6 2.5v5c0 3.5-4 6.7-6 8-2-1.3-6-4.5-6-8v-5Z" />}
    </svg>
  );
}

export function PermissionPicker() {
  const { t } = useI18n();
  // 本轮只展示模式切换；不绑定工具预设或实际权限。
  const [mode, setMode] = useState<"default" | "fullAccess">("fullAccess");
  const popup = useUpwardPopover(256, '[aria-checked="true"]', "start");
  const id = useId();
  const label = mode === "fullAccess" ? "Full access" : "Default";
  return <>
    <button ref={popup.anchorRef} type="button" className="composer-control-chip composer-permission-chip" data-mode={mode} aria-label={`${t("chat.permissionMode")}: ${label}`} aria-haspopup="menu" aria-expanded={popup.open} aria-controls={popup.open ? id : undefined} onClick={() => popup.open ? popup.setOpen(false) : popup.show()} onKeyDown={(event) => { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); popup.show(); } }}>
      <PermissionIcon fullAccess={mode === "fullAccess"} />
      <span>{label}</span>
    </button>
    {popup.open && createPortal(<div ref={popup.panelRef} id={id} role="menu" aria-label={t("chat.permissionMode")} className="composer-control-popover composer-permission-popover" style={popup.position} onKeyDown={(event) => {
      const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End") {
        event.preventDefault();
        const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
      }
    }}>
      {(["default", "fullAccess"] as const).map((item) => (
        <button key={item} type="button" role="menuitemradio" aria-checked={mode === item} data-mode={item} className="composer-control-option composer-permission-option" onClick={() => { setMode(item); popup.setOpen(false); popup.anchorRef.current?.focus(); }}>
          <PermissionIcon fullAccess={item === "fullAccess"} />
          <span className="composer-permission-copy">
            <span className="composer-permission-title">{item === "fullAccess" ? "Full access" : "Default"}</span>
            <span className="composer-permission-description">{t(item === "fullAccess" ? "chat.permissionFullAccessDescription" : "chat.permissionDefaultDescription")}</span>
          </span>
          {mode === item && <Check />}
        </button>
      ))}
    </div>, document.body)}
  </>;
}

export interface ContextRingProps {
  usage: { percent: number | null; contextWindow: number; tokens: number | null } | null | undefined;
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
}

export function ContextRing({ usage }: ContextRingProps) {
  const { t } = useI18n();
  const popup = useUpwardPopover(196, undefined, "center");
  const id = useId();
  if (usage?.percent == null) return null;
  const percent = Math.max(0, Math.min(100, usage.percent));
  const circumference = 2 * Math.PI * 7;
  const description = `${usage.tokens == null ? "—" : formatTokens(usage.tokens)} / ${formatTokens(usage.contextWindow)} tokens · ${percent.toFixed(0)}%`;
  return <>
    <button ref={popup.anchorRef} type="button" className="composer-context-ring" data-severity={percent < 60 ? "normal" : percent < 85 ? "warning" : "critical"} aria-label={`${t("chat.contextUsage")}: ${description}`} aria-describedby={popup.open ? id : undefined} onMouseEnter={popup.show} onMouseLeave={() => { if (document.activeElement !== popup.anchorRef.current) popup.setOpen(false); }} onFocus={popup.show} onBlur={() => popup.setOpen(false)} onClick={popup.show}>
      <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle className="composer-context-track" cx="10" cy="10" r="7" strokeWidth="2.5" /><circle className="composer-context-progress" cx="10" cy="10" r="7" strokeWidth="2.5" strokeLinecap="round" strokeDasharray={`${percent / 100 * circumference} ${circumference}`} transform="rotate(-90 10 10)" /></svg>
    </button>
    {popup.open && createPortal(<div ref={popup.panelRef} id={id} role="tooltip" className="composer-control-popover composer-context-tooltip" style={popup.position}>{description}</div>, document.body)}
  </>;
}
