// 确定性粒子参数让桌面等待页与应用首帧复用同一画面。
const goldenAngle = Math.PI * (3 - Math.sqrt(5));
const particles = Array.from({ length: 64 }, (_, index) => {
  const angle = index * goldenAngle;
  const radius = 13.2 * Math.sqrt(index + 1);
  const x = Math.cos(angle) * radius;
  const y = Math.sin(angle) * radius;
  return `<i class="sp-dot" style="--x:${x.toFixed(3)}px;--y:${y.toFixed(3)}px;--sx:${(x * 3 + Math.cos(angle) * 1100).toFixed(3)}px;--sy:${(y * 3 + Math.sin(angle) * 1100).toFixed(3)}px;--dot:${Math.max(3, 13.5 - radius * 0.1 + (index * 7) % 3 - 1).toFixed(2)}px;--alpha:${Math.max(0.35, 1.02 - radius * 0.0065).toFixed(2)};--duration:${3.1 + (index * 13) % 37 / 10}s;--delay:${-((index * 29) % 67) / 10}s"></i>`;
}).join("");

export const startupSplashMarkup = `<div class="sp-stack">
  <div class="sp-art" aria-hidden="true">
    <span class="sp-ring sp-ring-one"></span><span class="sp-ring sp-ring-two"></span>
    <div class="sp-orbit"><div class="sp-particles">${particles}</div></div>
  </div>
  <div class="sp-wordmark" aria-hidden="true">Weclio</div>
  <div class="sp-line" role="progressbar" aria-label="正在启动 Weclio"></div>
</div>`;

export const startupSplashStyles = `
#startup-splash {
  --sp-bg: #f8f7ff;
  --sp-ink: #1d1e21;
  position: fixed;
  inset: 0;
  z-index: 2147483000;
  display: grid;
  place-items: center;
  overflow: hidden;
  margin: 0;
  background: var(--sp-bg);
  color: var(--sp-ink);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
  text-align: center;
  isolation: isolate;
  pointer-events: auto;
  user-select: none;
}
html.dark #startup-splash { --sp-bg: #2e2e2e; --sp-ink: #f0f1f2; }
#startup-splash, #startup-splash * { box-sizing: border-box; }
#startup-splash[hidden] { display: none; }
#startup-splash .sp-stack { display: grid; place-items: center; width: 220px; height: 220px; }
#startup-splash .sp-stack > * { grid-area: 1 / 1; }
#startup-splash .sp-art { position: relative; width: 220px; height: 220px; }
#startup-splash .sp-orbit, #startup-splash .sp-particles { position: absolute; inset: 0; }
#startup-splash .sp-orbit { animation: sp-rotate 48s linear infinite; }
#startup-splash .sp-particles { animation: sp-breathe 5s ease-in-out infinite; }
#startup-splash .sp-dot {
  position: absolute;
  left: 50%;
  top: 50%;
  width: var(--dot);
  height: var(--dot);
  margin-left: calc(var(--dot) / -2);
  margin-top: calc(var(--dot) / -2);
  border-radius: 50%;
  background: radial-gradient(circle, currentColor, transparent 72%);
  opacity: var(--alpha);
  transform: translate3d(var(--x), var(--y), 0);
  animation: sp-drift var(--duration) ease-in-out var(--delay) infinite;
}
#startup-splash .sp-ring {
  position: absolute;
  inset: 0;
  border: 2px solid var(--sp-bg);
  box-shadow: 0 0 6px var(--sp-bg), inset 0 0 6px var(--sp-bg);
  border-radius: 50%;
  opacity: 0.08;
  animation: sp-sonar 6s ease-out infinite;
}
#startup-splash .sp-ring-two { animation-delay: -3s; }
#startup-splash .sp-wordmark {
  position: relative;
  text-shadow: 0 0 12px var(--sp-bg), 0 0 24px var(--sp-bg);
  font-family: Georgia, "Times New Roman", serif;
  font-size: 48px;
  line-height: 1.12;
  font-style: italic;
  font-weight: 400;
  letter-spacing: -2.4px;
}
#startup-splash .sp-line {
  width: min(320px, calc(100vw - 48px));
  height: 2px;
  border-radius: 2px;
  overflow: hidden;
  background: color-mix(in srgb, var(--sp-ink) 12%, transparent);
  opacity: 0;
  transform: translateY(160px);
  animation: sp-line-in 400ms ease-out 1200ms forwards;
}
#startup-splash .sp-line::after {
  content: "";
  display: block;
  width: 100%;
  height: 100%;
  background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--sp-ink) 55%, transparent), transparent);
  transform: translateX(-100%);
  animation: sp-sweep 1400ms ease-in-out 1200ms infinite;
}
#startup-splash[data-exit] { animation: sp-backdrop-exit 1500ms ease-in-out forwards; }
#startup-splash[data-exit] .sp-dot { animation: sp-scatter 1000ms cubic-bezier(0.2, 0.65, 0.25, 1) forwards; }
#startup-splash[data-exit] .sp-wordmark { animation: sp-word-exit 650ms ease-out forwards; }
#startup-splash[data-exit] .sp-line { opacity: 1; animation: sp-line-out 200ms ease-in forwards; }
#startup-splash[data-exit] .sp-line::after { animation: none; }
#startup-splash[data-exit] .sp-ring { animation: sp-word-exit 400ms ease-out forwards; }
#startup-content { flex: 1; display: flex; flex-direction: column; min-height: 0; opacity: 0; transition: opacity 350ms ease; }
#startup-content[data-visible] { opacity: 1; }
#startup-content[hidden] { display: none; }
@keyframes sp-line-in { to { opacity: 1; } }
@keyframes sp-line-out { to { opacity: 0; } }
@keyframes sp-sweep { to { transform: translateX(100%); } }
@keyframes sp-rotate { to { transform: rotate(360deg); } }
@keyframes sp-breathe { 0%, 100% { transform: scale(0.96); } 50% { transform: scale(1.04); } }
@keyframes sp-sonar { 0% { transform: scale(0.72); opacity: 0.13; } 100% { transform: scale(1.5); opacity: 0; } }
@keyframes sp-drift { 0%, 100% { transform: translate3d(var(--x), var(--y), 0); opacity: var(--alpha); } 50% { transform: translate3d(calc(var(--x) * 1.14), calc(var(--y) * 1.14), 0) scale(1.3); opacity: calc(var(--alpha) * .45); } }
@keyframes sp-scatter { to { transform: translate3d(var(--sx), var(--sy), 0) scale(0.25); opacity: 0; } }
@keyframes sp-word-exit { to { opacity: 0; filter: blur(3px); } }
@keyframes sp-backdrop-exit { 0%, 60% { opacity: 1; } 100% { opacity: 0; } }
@keyframes sp-fade-exit { from { opacity: 1; } to { opacity: 0; } }
@media (prefers-reduced-motion: reduce) {
  #startup-splash .sp-orbit, #startup-splash .sp-particles, #startup-splash .sp-ring, #startup-splash .sp-dot { animation: none; }
  #startup-splash .sp-ring { opacity: 0.06; }
  #startup-splash .sp-line { display: none; }
  #startup-splash .sp-line::after { animation: none; }
  #startup-splash[data-exit] { animation: sp-fade-exit 200ms linear forwards; }
  #startup-splash[data-exit] .sp-dot, #startup-splash[data-exit] .sp-wordmark, #startup-splash[data-exit] .sp-line, #startup-splash[data-exit] .sp-ring { animation: none; }
  #startup-content { transition-duration: 200ms; }
}
`;

// 服务启动前读不到应用主题，只有桌面等待页跟随系统配色。
export function desktopStartupPage() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><title>Weclio</title><style>${startupSplashStyles}
@media (prefers-color-scheme: dark) { html:not(.light) #startup-splash { --sp-bg: #2e2e2e; --sp-ink: #f0f1f2; } }
</style></head><body><main id="startup-splash" role="status" aria-label="正在启动 Weclio">${startupSplashMarkup}</main></body></html>`;
}
