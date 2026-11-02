interface WindowControlsOverlay extends EventTarget {
  readonly visible: boolean;
}

// 只在系统按钮覆盖层启用时接管顶栏；普通浏览器不改变布局或主题元数据。
export function bindWindowControlsOverlay(): (() => void) | undefined {
  const overlay = (navigator as Navigator & { windowControlsOverlay?: WindowControlsOverlay }).windowControlsOverlay;
  if (!overlay) return;

  const root = document.documentElement;
  let themeColor: HTMLMetaElement | null = null;
  const sync = () => {
    root.toggleAttribute("data-window-controls-overlay", overlay.visible);
    if (!overlay.visible) {
      themeColor?.remove();
      themeColor = null;
      return;
    }
    if (!themeColor) {
      themeColor = document.createElement("meta");
      themeColor.name = "theme-color";
      document.head.append(themeColor);
    }
    // Electron 原生接收 theme-color 变化，无需将窗口控制能力暴露给页面。
    const color = getComputedStyle(root).getPropertyValue("--bg-panel").trim();
    if (themeColor.content !== color) themeColor.content = color;
  };

  sync();
  overlay.addEventListener("geometrychange", sync);
  const observer = new MutationObserver(sync);
  observer.observe(root, { attributes: true, attributeFilter: ["class"] });
  return () => {
    overlay.removeEventListener("geometrychange", sync);
    observer.disconnect();
    root.removeAttribute("data-window-controls-overlay");
    themeColor?.remove();
  };
}
