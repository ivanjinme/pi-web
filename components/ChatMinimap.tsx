"use client";

import { useEffect, useRef, useState, useCallback, useMemo, RefObject } from "react";
import type { AgentMessage, AssistantMessage, TextContent } from "@/lib/types";

interface Props {
  messages: AgentMessage[];
  streamingMessage: Partial<AgentMessage> | null;
  scrollContainer: RefObject<HTMLDivElement | null>;
  messageRefs: RefObject<(HTMLDivElement | null)[]>;
}

function getMessagePreview(msg: AgentMessage | Partial<AgentMessage>): string {
  if (msg.role === "user") {
    const content = msg.content;
    if (typeof content === "string") return content.slice(0, 200);
    if (Array.isArray(content)) {
      return (content as { type: string; text?: string }[])
        .filter((b) => b.type === "text" && b.text)
        .map((b) => b.text!)
        .join("\n")
        .slice(0, 200);
    }
    return "";
  }
  if (msg.role === "assistant") {
    const blocks = (msg as Partial<AssistantMessage>).content ?? [];
    const text = blocks
      .filter((b): b is TextContent => b.type === "text")
      .map((b) => b.text)
      .join(" ");
    if (text) return text.slice(0, 200);
    const toolNames = blocks
      .filter((b) => b.type === "toolCall")
      .map((b) => (b as { type: string; toolName: string }).toolName);
    if (toolNames.length) return toolNames.join(", ");
    return "";
  }
  return "";
}

function hasTextContent(msg: AgentMessage | Partial<AgentMessage>): boolean {
  if (msg.role === "user") return true;
  if (msg.role === "assistant") {
    const blocks = (msg as Partial<AssistantMessage>).content ?? [];
    return blocks.some((b) => b.type === "text");
  }
  return false;
}

interface NodeInfo {
  topRatio: number;   // 0–1 within total scroll height
  msg: AgentMessage | Partial<AgentMessage>;
  index: number;
}

export function ChatMinimap({ messages, streamingMessage, scrollContainer, messageRefs }: Props) {
  const [scrollRatio, setScrollRatio] = useState(0);
  const [viewportRatio, setViewportRatio] = useState(1);
  const [visible, setVisible] = useState(false);
  const [nodes, setNodes] = useState<NodeInfo[]>([]);
  const [minimapHovered, setMinimapHovered] = useState(false);
  const [mouseYRatio, setMouseYRatio] = useState<number | null>(null);
  const draggingRef = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const allMessages = useMemo(
    () => (streamingMessage ? [...messages, streamingMessage] : messages) as (AgentMessage | Partial<AgentMessage>)[],
    [messages, streamingMessage]
  );
  const allMessagesRef = useRef(allMessages);
  allMessagesRef.current = allMessages;

  // --- 仅更新视口比例，不读取 DOM ---
  const updateScroll = useCallback(() => {
    const scrollEl = scrollContainer.current;
    if (!scrollEl) return;
    const totalH = scrollEl.scrollHeight;
    const clientH = scrollEl.clientHeight;
    const scrollable = totalH - clientH;
    setVisible(scrollable > 20);
    if (scrollable <= 0) {
      setScrollRatio(0);
      setViewportRatio(1);
    } else {
      setScrollRatio(scrollEl.scrollTop / scrollable);
      setViewportRatio(clientH / totalH);
    }
  }, [scrollContainer]);

  // --- 节流 DOM 测量（仅消息变化/尺寸变化时触发，最多 150ms 一次）---
  const measureThrottleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const measureNodes = useCallback(() => {
    // 节流：150ms 内忽略重复调用
    if (measureThrottleRef.current) return;
    measureThrottleRef.current = setTimeout(() => {
      measureThrottleRef.current = null;
      const scrollEl = scrollContainer.current;
      if (!scrollEl) return;
      const totalH = scrollEl.scrollHeight;
      if (totalH <= 0) return;

      const refs = messageRefs.current;
      const newNodes: NodeInfo[] = [];
      let refIndex = 0;
      const allMessages = allMessagesRef.current;

      for (let i = 0; i < allMessages.length; i++) {
        const msg = allMessages[i];
        if (msg.role !== "user" && msg.role !== "assistant") continue;
        const el = refs?.[refIndex];
        refIndex++;
        if (!hasTextContent(msg)) continue;
        if (el) {
          const elRect = el.getBoundingClientRect();
          const containerRect = scrollEl.getBoundingClientRect();
          const top = elRect.top - containerRect.top + scrollEl.scrollTop;
          newNodes.push({
            topRatio: top / totalH,
            msg,
            index: newNodes.length,
          });
        }
      }
      setNodes(newNodes);
    }, 150);
  }, [scrollContainer, messageRefs]);

  // scroll 事件 → 只更新视口，不碰 DOM
  useEffect(() => {
    const el = scrollContainer.current;
    if (!el) return;
    el.addEventListener("scroll", updateScroll, { passive: true });
    return () => el.removeEventListener("scroll", updateScroll);
  }, [scrollContainer, updateScroll]);

  // Keep both node positions and viewport ratios in sync with layout changes.
  useEffect(() => {
    const el = scrollContainer.current;
    if (!el) return;
    const syncLayout = () => {
      updateScroll();
      measureNodes();
    };
    const ro = new ResizeObserver(syncLayout);
    ro.observe(el);
    // Also observe the scroll content for height changes
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    syncLayout();
    return () => {
      ro.disconnect();
      if (measureThrottleRef.current) {
        clearTimeout(measureThrottleRef.current);
        measureThrottleRef.current = null;
      }
    };
  }, [scrollContainer, measureNodes, updateScroll]);

  // Wait briefly for new message DOM before syncing layout.
  useEffect(() => {
    const t = setTimeout(() => {
      updateScroll();
      measureNodes();
    }, 50);
    return () => clearTimeout(t);
  }, [messages.length, measureNodes, updateScroll]);

  const scrollToMinimapRatio = useCallback((viewportTopRatio: number) => {
    const el = scrollContainer.current;
    if (!el) return;
    const scrollable = el.scrollHeight - el.clientHeight;
    if (scrollable <= 0) return;
    const clamped = Math.max(0, Math.min(1 - viewportRatio, viewportTopRatio));
    el.scrollTop = (clamped / (1 - viewportRatio)) * scrollable;
  }, [scrollContainer, viewportRatio]);

  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!visible) return;

    draggingRef.current = true;
    const rect = e.currentTarget.getBoundingClientRect();
    const clickRatio = (e.clientY - rect.top) / rect.height;
    const grabOffset = clickRatio - scrollRatio * (1 - viewportRatio);
    const insideBox = grabOffset >= 0 && grabOffset <= viewportRatio;
    const offset = insideBox ? grabOffset : viewportRatio / 2;

    scrollToMinimapRatio(clickRatio - offset);

    const onMove = (ev: MouseEvent) => {
      if (!draggingRef.current) return;
      const r = (ev.clientY - rect.top) / rect.height;
      scrollToMinimapRatio(r - offset);
    };
    const onUp = () => {
      draggingRef.current = false;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [visible, viewportRatio, scrollRatio, scrollToMinimapRatio]);



  const minimapHeightPx = containerRef.current?.clientHeight ?? 600;

  if (!visible) return null;

  const viewportTopRatio = scrollRatio * (1 - viewportRatio);

  // Keep the marks in one centered, evenly spaced cluster. Their position in
  // the document still drives navigation; only the visual rhythm is normalized.
  const markPitch = nodes.length > 1
    ? Math.min(10, Math.max(4, (minimapHeightPx - 24) / (nodes.length - 1)))
    : 0;
  const clusterHeight = markPitch * Math.max(0, nodes.length - 1);
  const clusterTop = (minimapHeightPx - clusterHeight) / 2;
  const displayRatioFor = (index: number) => (clusterTop + index * markPitch) / minimapHeightPx;

  // Find the message closest to the pointer, then reveal one calm preview card.
  const nearestIndex = mouseYRatio !== null && nodes.length > 0
    ? nodes.reduce((best, node) => (
        Math.abs(displayRatioFor(node.index) - mouseYRatio)
          < Math.abs(displayRatioFor(nodes[best].index) - mouseYRatio) ? node.index : best
      ), 0)
    : null;
  const currentIndex = nodes.length > 0
    ? nodes.reduce((best, node) => (
        Math.abs(node.topRatio - (viewportTopRatio + viewportRatio / 2))
          < Math.abs(nodes[best].topRatio - (viewportTopRatio + viewportRatio / 2)) ? node.index : best
      ), 0)
    : null;
  const activeIndex = nearestIndex ?? currentIndex;
  const nearestNode = nearestIndex === null ? null : nodes.find((node) => node.index === nearestIndex) ?? null;
  const nearestPreview = nearestNode ? getMessagePreview(nearestNode.msg) : "";
  const previewTop = nearestNode
    ? Math.max(12, Math.min(minimapHeightPx - 132, clusterTop + nearestNode.index * markPitch - 46))
    : 12;

  return (
    <div
      ref={containerRef}
      onMouseDown={handleMouseDown}
      onMouseEnter={() => setMinimapHovered(true)}
      onMouseLeave={() => { setMinimapHovered(false); setMouseYRatio(null); }}
      onMouseMove={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        setMouseYRatio((event.clientY - rect.top) / rect.height);
      }}
      className="chat-history-rail"
      role="navigation"
      aria-label="Chat history navigator"
    >
      {nodes.map((node) => {
        const isNearest = activeIndex === node.index;
        const inViewport = node.topRatio >= viewportTopRatio && node.topRatio <= viewportTopRatio + viewportRatio;
        const distance = nearestIndex === null ? Number.POSITIVE_INFINITY : Math.abs(node.index - nearestIndex);
        const wave = distance < 5 ? (1 + Math.cos(Math.PI * distance / 5)) / 2 : 0;
        const width = minimapHovered ? Math.round(8 + 26 * wave) : 8;

        return (
          <button
            key={node.index}
            type="button"
            className="chat-history-rail-hit"
            style={{ top: clusterTop + node.index * markPitch }}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={() => scrollToMinimapRatio(node.topRatio - viewportRatio / 2)}
            aria-label={`Go to ${node.msg.role === "user" ? "your" : "assistant"} message ${node.index + 1}`}
          >
            <div
              className={`chat-history-rail-mark${isNearest ? " is-nearest" : ""}${inViewport ? " is-visible" : ""}`}
              style={{ width }}
            />
          </button>
        );
      })}

      {minimapHovered && nearestNode && nearestPreview && (
        <div
          className="chat-history-preview"
          style={{ top: previewTop }}
          aria-hidden="true"
        >
          <div className="chat-history-preview-role">
            {nearestNode.msg.role === "user" ? "You" : "Assistant"}
          </div>
          <div className="chat-history-preview-copy">{nearestPreview}</div>
        </div>
      )}
    </div>
  );
}

// Hook to create a stable array of refs for messages
export function useMessageRefs(count: number): RefObject<(HTMLDivElement | null)[]> {
  const refs = useRef<(HTMLDivElement | null)[]>([]);
  refs.current = Array(count).fill(null).map((_, i) => refs.current[i] ?? null);
  return refs;
}
