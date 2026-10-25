import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";
import ts from "typescript";
import { runInNewContext } from "node:vm";

const jiti = createJiti(import.meta.url);
const { visibleThreadRoots } = await jiti.import("../lib/sidebar-session-list.ts");

const source = await readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");
const sessionItemSource = source.slice(source.indexOf("function SessionItem("));

// 执行组件本身的目录/标题 hooks，并在异步更新后批量渲染。
function titleLoaderHarness(fetch) {
  const ast = ts.createSourceFile("SessionSidebar.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const component = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "SessionSidebar");
  const names = new Set(["allSessions", "loading", "error", "catalogGeneration", "listRequestRef", "loadSessions", "titleRequestKey"]);
  const statements = component.body.statements.filter((node) => {
    if (ts.isVariableStatement(node)) {
      const name = node.declarationList.declarations[0].name;
      return names.has(ts.isArrayBindingPattern(name) ? name.elements[0].name.text : name.text);
    }
    return ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
      && node.expression.expression.getText(ast) === "useEffect"
      && node.expression.arguments[1]?.getText(ast).includes("titleRequestKey");
  });
  const compiled = ts.transpileModule(`(function render() {
    ${statements.map((node) => node.getText(ast)).join("\n")}
    return { loadSessions, allSessions, error };
  })`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  const slots = [];
  let cursor = 0;
  let dirty = false;
  let effectDeps;
  let cleanup;
  let pendingEffect;
  const render = runInNewContext(compiled, {
    fetch, AbortController,
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], (value) => {
        const next = typeof value === "function" ? value(slots[index]) : value;
        if (!Object.is(next, slots[index])) { slots[index] = next; dirty = true; }
      }];
    },
    useRef(initial) {
      const index = cursor++;
      return slots[index] ??= { current: initial };
    },
    useCallback: (callback) => callback,
    useMemo: (callback) => callback(),
    useEffect(callback, deps) {
      if (!effectDeps || deps.some((value, index) => !Object.is(value, effectDeps[index]))) {
        effectDeps = deps;
        pendingEffect = callback;
      }
    },
    normalizedSessionSearch: "search",
    projectsOpen: true, visibleProjectGroups: [], pinsOpen: false, visiblePins: [],
    projectGroups: [], projectVisibleCounts: {}, selectedSessionId: null,
    sseAuthoritativeRef: { current: true },
    setRunningSessionIds() {}, setUnreadSessionIds() {},
  });
  let current;
  function flush() {
    for (let count = 0; count < 20; count++) {
      if (current && !dirty) return;
      dirty = false;
      cursor = 0;
      current = render();
      if (pendingEffect) {
        cleanup?.();
        const callback = pendingEffect;
        pendingEffect = undefined;
        cleanup = callback();
      }
    }
    assert.fail("title loading entered a render loop");
  }
  flush();
  return {
    get current() { return current; },
    async settle() {
      for (let count = 0; count < 10; count++) {
        await new Promise((resolve) => setImmediate(resolve));
        flush();
      }
    },
  };
}

function historyGroup() {
  const roots = Array.from({ length: 20 }, (_, index) => ({ session: { id: `root-${index}` }, children: [] }));
  const child = { session: { id: "child", parentSessionId: "root-19" }, children: [] };
  roots[19].children.push(child);
  return { roots, sessions: [...roots.map((node) => node.session), child.session] };
}

test("identical successful catalog refresh retries failed titles without looping or discarding cached titles", async () => {
  let titleRequests = 0;
  let failTitles = true;
  const catalog = [{ id: "thread", modified: "revision", cwd: "/project", titleLoaded: false }];
  const harness = titleLoaderHarness(async (_url, options) => {
    if (options?.method === "POST") {
      titleRequests++;
      return { ok: !failTitles, status: 503, json: async () => ({ titles: [{ id: "thread", name: "Recovered title", firstMessage: "hello" }] }) };
    }
    return { ok: true, json: async () => ({ sessions: catalog }) };
  });
  await harness.current.loadSessions();
  await harness.settle();
  assert.equal(titleRequests, 1);
  assert.match(harness.current.error, /503/);
  await harness.current.loadSessions();
  await harness.settle();
  assert.equal(titleRequests, 2, "persistent failure retries only once per successful catalog refresh");
  failTitles = false;
  await harness.current.loadSessions();
  await harness.settle();
  assert.equal(titleRequests, 3);
  assert.equal(harness.current.allSessions[0].name, "Recovered title");
  assert.equal(harness.current.allSessions[0].titleLoaded, true);
  assert.equal(harness.current.error, null);
  await harness.current.loadSessions();
  await harness.settle();
  assert.equal(titleRequests, 3, "loaded titles remain cached across identical catalogs");
  assert.equal(harness.current.allSessions[0].name, "Recovered title");
});

test("search loads only missing titles and reuses already loaded display titles", async () => {
  const requests = [];
  const catalog = [
    { id: "loaded", modified: "revision", name: "Cached title", firstMessage: "original prompt", titleLoaded: true },
    { id: "missing", modified: "revision", firstMessage: "", titleLoaded: false },
  ];
  const harness = titleLoaderHarness(async (_url, options) => {
    if (options?.method === "POST") {
      requests.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ titles: [{ id: "missing", name: "Loaded title", firstMessage: "" }] }) };
    }
    return { ok: true, json: async () => ({ sessions: catalog }) };
  });
  await harness.current.loadSessions();
  await harness.settle();
  assert.deepEqual(requests, [{ ids: ["missing"] }]);
  assert.equal(harness.current.allSessions[0].name, "Cached title");
  assert.equal(harness.current.allSessions[1].name, "Loaded title");
  await harness.current.loadSessions();
  await harness.settle();
  assert.equal(requests.length, 1);
});

test("pinned and project session search share the displayed title with each row", () => {
  assert.equal(source.match(/!sessionDisplayTitle\(session\)\.toLowerCase\(\)\.includes\(normalizedSessionSearch\)/g)?.length, 2);
  assert.match(sessionItemSource, /const title = session\.titleLoaded === false \? "…" : sessionDisplayTitle\(session\);/);
});

test("a superseded title response cannot overwrite the refreshed catalog", async () => {
  const pending = [];
  let titleRequests = 0;
  const harness = titleLoaderHarness(async (_url, options) => {
    if (options?.method === "POST") {
      titleRequests++;
      return new Promise((resolve) => pending.push(resolve));
    }
    return { ok: true, json: async () => ({ sessions: [{ id: "thread", modified: "revision", cwd: "/project" }] }) };
  });
  await harness.current.loadSessions();
  await harness.settle();
  await harness.current.loadSessions();
  await harness.settle();
  assert.equal(titleRequests, 2);
  const response = (name) => ({ ok: true, json: async () => ({ titles: [{ id: "thread", name, firstMessage: "hello" }] }) });
  pending[1](response("Current title"));
  await harness.settle();
  pending[0](response("Stale title"));
  await harness.settle();
  assert.equal(harness.current.allSessions[0].name, "Current title");
});

test("project history reveals ten more threads per click and resets after the last page", () => {
  assert.match(source, /const visibleCount = projectVisibleCounts\[group\.root\] \?\? 5;/);
  assert.match(source, /const hasMore = roots\.length > visibleCount;/);
  assert.match(source, /const visibleRoots = visibleThreadRoots\(group, visibleCount, selectedSessionId\);/);
  assert.match(source, /\{visibleRoots\.map\(\(node\) => \(/);
  assert.match(source, /\.\.\.previous,\s*\[group\.root\]: hasMore \? \(previous\[group\.root\] \?\? 5\) \+ 10 : 5,/);
  assert.match(source, /\{hasMore \? "Show more" : "Show less"\}/);

  const group = historyGroup();
  for (const count of [5, 15, 25, 5]) {
    assert.deepEqual(visibleThreadRoots(group, count, null), group.roots.slice(0, count));
  }
});

test("selected history threads remain visible within the current page size", () => {
  assert.match(source, /const visibleRoots = visibleThreadRoots\(group, visibleCount, selectedSessionId\);/);

  const group = historyGroup();
  for (const count of [5, 15, 5]) {
    for (const selectedId of ["root-19", "child"]) {
      const visible = visibleThreadRoots(group, count, selectedId);
      assert.equal(visible.length, count);
      assert.deepEqual(visible, [...group.roots.slice(0, count - 1), group.roots[19]]);
      assert.ok(!visible.includes(group.roots[count - 1]));
      assert.equal(visible.at(-1).children[0].session.id, "child");
    }
    assert.deepEqual(visibleThreadRoots(group, count, "root-0"), group.roots.slice(0, count));
  }
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
