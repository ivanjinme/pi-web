import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: true });
const { formatCodexResetTime } = await jiti.import("./CodexUsagePanel.tsx");

const panel = await readFile(new URL("./CodexUsagePanel.tsx", import.meta.url), "utf8");
const shell = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const hook = await readFile(new URL("../hooks/useCodexUsage.ts", import.meta.url), "utf8");
const route = await readFile(new URL("../app/api/usage/codex/route.ts", import.meta.url), "utf8");
const styles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

test("usage precedes Settings and requests only on menu opening", () => {
  assert.match(shell, /useCodexUsage\(userMenuOpen\)/);
  assert.match(shell, /<CodexUsagePanel usage=\{codexUsage\} \/>\s*<button[^>]+onClick=\{openSettings\}/);
  assert.match(hook, /if \(!menuOpen\) return;/);
  assert.match(hook, /\}, \[menuOpen\]\);/);
  assert.match(hook, /controller\.abort\(\)/);
  assert.doesNotMatch(panel, /fetch\(|router|href=|refresh/i);
});

test("inline disclosure uses existing menu buttons and exposes expanded state", () => {
  assert.match(panel, /role="menuitem" aria-expanded=\{expanded\} aria-controls=\{detailsId\}/);
  assert.match(panel, /className="codex-usage-chevron" aria-hidden="true">›<\/span>/);
  assert.match(panel, /\{expanded && \(/);
  assert.match(panel, /UsageWindow label="5 hour" window=\{available\.primary\}/);
  assert.match(panel, /UsageWindow label="Weekly" window=\{available\.secondary\}/);
  assert.match(panel, /toLocaleString/);
  assert.match(panel, /unavailable/);
});

test("percentage stays beside the label and details form a compact indented subgroup", () => {
  assert.match(panel, /className="codex-usage-label">Usage remaining <span>\{summary\}<\/span><\/span>/);
  assert.match(styles, /\.codex-usage-label \{[^}]*display: inline-flex;[^}]*gap: 4px;/);
  assert.match(styles, /\.codex-usage-chevron \{\s*margin-left: auto;/);
  assert.match(styles, /\.codex-usage-details \{[^}]*margin-top: -2px;[^}]*padding: 0 9px 6px 39px;[^}]*line-height: 18px;/);
  const rowStyles = styles.match(/\.codex-usage-window \{([^}]*)\}/)?.[1];
  assert.ok(rowStyles);
  assert.doesNotMatch(rowStyles, /padding:/);
});

test("reset times use local HH:mm MM-DD with zero padding and a 24-hour clock", () => {
  assert.equal(formatCodexResetTime(new Date(2026, 0, 2, 3, 4)), "03:04 01-02");
  assert.equal(formatCodexResetTime(new Date(2026, 9, 2, 0, 0)), "00:00 10-02");
  assert.equal(formatCodexResetTime(new Date(2026, 11, 31, 23, 59)), "23:59 12-31");
  assert.match(panel, /\{formatCodexResetTime\(reset\)\}/);
});

test("clock icon and larger chevron keep the existing menu styling", () => {
  assert.match(panel, /<circle cx="12" cy="12" r="9" \/><path d="M12 7v5l3 2" \/>/);
  assert.match(styles, /\.codex-usage-chevron \{[^}]*font-size: 20px;/);
});

test("expanded chevron rotates the same glyph without changing its size", () => {
  assert.match(styles, /\.codex-usage-chevron \{[^}]*font-size: 20px;/);
  const expandedStyles = styles.match(/\.codex-usage-panel button\[aria-expanded="true"\] \.codex-usage-chevron \{([^}]*)\}/)?.[1];
  assert.ok(expandedStyles);
  assert.match(expandedStyles, /transform: rotate\(90deg\);/);
  assert.doesNotMatch(expandedStyles, /font-size:|scale\(/);
});

test("window percentages sit next to reset times and fixed menu width leaves sidebar edge space", () => {
  assert.match(panel, /className="codex-usage-percent">\{percent\(window\)\}/);
  assert.match(styles, /\.codex-usage-window \{[^}]*grid-template-columns: minmax\(0, 1fr\) auto auto;[^}]*gap: 6px;/);
  const menuStyles = styles.match(/\.sidebar-user-menu \{([^}]*)\}/)?.[1];
  const minimumWidth = Number(shell.match(/const SIDEBAR_MIN_WIDTH = (\d+);/)?.[1]);
  assert.ok(menuStyles);
  assert.equal(minimumWidth, 256);
  assert.match(styles, /\.sidebar-container\.sidebar-open \{[^}]*min-width: 256px;/);
  assert.match(menuStyles, /width: 240px;/);
  const inset = Number(menuStyles.match(/left: (\d+)px;/)?.[1]);
  assert.equal(inset, 8);
  assert.match(menuStyles, new RegExp(`width: ${minimumWidth - inset * 2}px;`));
  assert.doesNotMatch(menuStyles, /right:/);
});

test("each available window has a compact ten-segment remaining bar with accessible values", () => {
  assert.match(panel, /\{window && \(\s*<span className="codex-usage-progress" role="progressbar"/);
  assert.match(panel, /aria-label=\{`\$\{label\} remaining`\} aria-valuemin=\{0\} aria-valuemax=\{100\} aria-valuenow=\{window\.remainingPercent\}/);
  assert.match(panel, /Array\.from\(\{ length: 10 \}/);
  assert.match(panel, /data-filled=\{index < Math\.round\(window\.remainingPercent \/ 10\)\}/);
  assert.match(styles, /\.codex-usage-progress \{[^}]*grid-column: 1 \/ -1;[^}]*grid-template-columns: repeat\(10, minmax\(0, 1fr\)\);[^}]*height: 4px;/);
  assert.match(styles, /\.codex-usage-progress > span \{\s*background: var\(--border\);/);
  assert.match(styles, /\.codex-usage-progress > span\[data-filled="true"\] \{\s*background: var\(--text-muted\);/);
});

test("client imports only usage types and API responses cannot be browser-cached", () => {
  assert.match(panel, /import type \{ CodexUsage, CodexUsageWindow \}/);
  assert.match(hook, /import type \{ CodexUsage \}/);
  assert.match(route, /"Cache-Control": "no-store"/);
  assert.doesNotMatch(hook + panel, /apiKey|Authorization|accountId|ModelRuntime|auth\.json/);
});
