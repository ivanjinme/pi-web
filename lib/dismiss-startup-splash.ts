// 仅操作首页根节点持有的开屏；后续会话切换不重新创建开屏。
export function dismissStartupSplash(): (() => void) | undefined {
  const splash = document.getElementById("startup-splash");
  const content = document.getElementById("startup-content");
  if (!splash || !content || splash.hidden) return;

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let secondFrame = 0;
  let exitTimer = 0;
  // 等待就绪内容提交后的绘制，不把 fetch 完成当作首屏完成。
  const firstFrame = window.requestAnimationFrame(() => {
    secondFrame = window.requestAnimationFrame(() => {
      splash.setAttribute("data-exit", "");
      content.setAttribute("data-visible", "");
      exitTimer = window.setTimeout(() => {
        splash.hidden = true;
        content.inert = false;
      }, reducedMotion ? 200 : 1500);
    });
  });

  return () => {
    window.cancelAnimationFrame(firstFrame);
    window.cancelAnimationFrame(secondFrame);
    window.clearTimeout(exitTimer);
    if (!splash.hidden) {
      splash.removeAttribute("data-exit");
      content.removeAttribute("data-visible");
    }
  };
}
