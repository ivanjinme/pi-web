import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");
const sessionItemSource = source.slice(source.indexOf("function SessionItem("));

test("project history reveals ten more threads per click and resets after the last page", () => {
  assert.match(source, /const visibleCount = projectVisibleCounts\[group\.root\] \?\? 5;/);
  assert.match(source, /const hasMore = roots\.length > visibleCount;/);
  assert.match(source, /let visibleRoots = roots\.slice\(0, visibleCount\);/);
  assert.match(source, /\.\.\.previous,\s*\[group\.root\]: hasMore \? \(previous\[group\.root\] \?\? 5\) \+ 10 : 5,/);
  assert.match(source, /\{hasMore \? "Show more" : "Show less"\}/);
});

test("selected history threads remain visible within the current page size", () => {
  assert.match(source, /visibleRoots = \[\.\.\.visibleRoots\.slice\(0, visibleCount - 1\), selectedRoot\];/);
});

test("Pinned precedes Projects and opens the original session rather than a copy", () => {
  const pinnedSection = source.slice(source.indexOf('<section className="pinned-section"'), source.indexOf('{projectsOpen && visibleProjectGroups.map(renderProjectGroup)}'));
  assert.ok(pinnedSection.indexOf("<span>Pinned</span>") < pinnedSection.indexOf("<span>Projects</span>"));
  assert.match(pinnedSection, /onClick=\{\(\) => handleSelectSessionFromList\(session\)\}/);
  assert.match(pinnedSection, /onRenamed=\{loadSessions\}/);
  assert.match(pinnedSection, /onDeleted=\{handleSessionDeleted\}/);
  assert.match(pinnedSection, /runningSessionIds\.has\(session\.id\)/);
  assert.match(pinnedSection, /unreadSessionIds\.has\(session\.id\)/);
});

test("pinned threads are excluded before building project history trees", () => {
  assert.match(source, /const sessions = group\.sessions\.filter\(\(session\) => !pinnedSessionIds\.has\(session\.id\)\);\s*return \{ \.\.\.group, sessions, roots: buildSessionTree\(sessions\) \};/);
});

test("pinned projects are excluded before project pagination and selection", () => {
  assert.match(source, /const unpinnedProjectGroups = useMemo\(\(\) => projectGroups\.filter\(\(group\) => !pinnedProjects\.has\(projectPathKey\(group\.root\)\)\)/);
  assert.match(source, /const visible = unpinnedProjectGroups\.slice\(0, 5\);/);
  assert.match(source, /const selected = unpinnedProjectGroups\.find/);
  assert.match(source, /Show \$\{unpinnedProjectGroups\.length - 5\} more projects/);
});

test("pinned projects retain the same history renderer and controls", () => {
  assert.match(source, /renderProjectGroup\(projectGroups\.find/);
  assert.match(source, /visibleProjectGroups\.map\(renderProjectGroup\)/);
  assert.equal(source.match(/className="project-section"/g)?.length, 1);
  assert.match(source, /normalizedSessionSearch[\s\S]*?&& !group\?\.sessions\.length\) return \[\];/);
});

test("fork children receive the same pin state and actions as root threads", () => {
  assert.match(source, /pinnedSessionIds=\{pinnedSessionIds\}\s*onTogglePin=\{onTogglePin\}\s*pinDisabled=\{pinDisabled\}\s*depth=\{depth \+ 1\}/);
  assert.match(sessionItemSource, /disabled=\{pinDisabled\} onClick=\{onTogglePin\}/);
  assert.match(sessionItemSource, /\{isPinned \? "Unpin" : "Pin"\}/);
});

test("Pinned is hidden without visible pins and has no import or empty-state prompts", () => {
  assert.match(source, /\{visiblePins\.length > 0 && \(\s*<section className="pinned-section"/);
  assert.doesNotMatch(source, /Import saved project pins|Pin projects or threads|No matching pins|Loading pins/);
  assert.doesNotMatch(source, /legacyPinnedProjects|LEGACY_PINNED_PROJECTS_STORAGE_KEY|importLegacyPins/);
});

test("pin menu clicks close the menu without selecting the thread", () => {
  assert.match(source, /onClick=\{\(event\) => \{ event\.stopPropagation\(\); setOpen\(false\); \}\}/);
});

test("only Shift+click bypasses session deletion confirmation", () => {
  assert.match(
    sessionItemSource,
    /const handleDeleteClick[\s\S]*?if \(e\.shiftKey\) \{\s*void performDelete\(\);\s*\} else \{\s*setConfirmDelete\(true\);/,
  );
});

test("does not register row-level session deletion shortcuts", () => {
  assert.doesNotMatch(sessionItemSource, /const handleKeyDown/);
  assert.doesNotMatch(sessionItemSource, /onKeyDown=\{handleKeyDown\}/);
  assert.doesNotMatch(sessionItemSource, /tabIndex=\{0\}/);
});
