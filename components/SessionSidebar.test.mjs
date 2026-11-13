import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";
import ts from "typescript";
import { runInNewContext } from "node:vm";

const jiti = createJiti(import.meta.url);
const { visibleThreadRoots, threadTitleIds, sessionDisplayTitle } = await jiti.import("../lib/sidebar-session-list.ts");
const { projectPathKey, isProjectFolderHidden } = await jiti.import("../lib/project-folders.ts");

const source = await readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");
const sessionItemSource = source.slice(source.indexOf("function SessionItem("));
const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

// 执行组件本身的目录/标题 hooks，并在异步更新后批量渲染。
function titleLoaderHarness(fetch, overrides = {}) {
  const ast = ts.createSourceFile("SessionSidebar.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const component = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "SessionSidebar");
  const names = new Set(["allSessions", "loading", "error", "catalogGeneration", "listRequestRef", "loadSessions", "titleRequestKey", "defaultWorkspace"]);
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
    return { loadSessions, allSessions, error, defaultWorkspace };
  })`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  const slots = [];
  let cursor = 0;
  let dirty = false;
  let effectDeps;
  let cleanup;
  let pendingEffect;
  const context = {
    fetch, AbortController, threadTitleIds, visibleThreadRoots, projectPathKey,
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
    tasksOpen: true, tasksGroup: null,
    projectGroups: [], projectVisibleCounts: {}, collapsedProjects: {}, selectedSessionId: null,
    sseAuthoritativeRef: { current: true },
    setRunningSessionIds() {}, setUnreadSessionIds() {},
    ...overrides,
  };
  const render = runInNewContext(compiled, context);
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
    update(values) { Object.assign(context, values); dirty = true; flush(); },
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
  const harness = titleLoaderHarness(async (url, options) => {
    if (url === "/api/cwd/default") return { ok: true, json: async () => ({ cwd: "/workspace" }) };
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
  const harness = titleLoaderHarness(async (url, options) => {
    if (url === "/api/cwd/default") return { ok: true, json: async () => ({ cwd: "/workspace" }) };
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
  const harness = titleLoaderHarness(async (url, options) => {
    if (url === "/api/cwd/default") return { ok: true, json: async () => ({ cwd: "/workspace" }) };
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

test("project history reveals ten more threads per click without Show less", () => {
  assert.match(source, /const visibleCount = projectVisibleCounts\[group\.root\] \?\? 5;/);
  assert.match(source, /const hasMore = roots\.length > visibleCount;/);
  assert.match(source, /const visibleRoots = visibleThreadRoots\(group, visibleCount, selectedSessionId\);/);
  assert.match(source, /\{visibleRoots\.map\(\(node\) => \(/);
  assert.match(source, /\.\.\.previous,\s*\[group\.root\]: \(previous\[group\.root\] \?\? 5\) \+ 10,/);
  assert.match(source, /\{hasMore && \(/);
  assert.doesNotMatch(source, /Show less/);

  const group = historyGroup();
  for (const count of [5, 15, 25, 5]) {
    assert.deepEqual(visibleThreadRoots(group, count, null), group.roots.slice(0, count));
  }
});

function projectGroupHarness(fetch = async () => { throw new Error("Unexpected fetch"); }) {
  const start = source.indexOf("  function renderProjectGroup(");
  const end = source.indexOf("\n  return (", start);
  const compiled = ts.transpileModule(`${source.slice(start, end)}\nrenderProjectGroup`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
  }).outputText;
  const errors = [];
  const context = {
    fetch,
    setError: () => assert.fail("creation failures must not hide the catalog"),
    setTaskCreationError: (error) => { context.taskCreationError = error; if (error) errors.push(error); },
    React: { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }) },
    projectVisibleCounts: {}, collapsedProjects: {}, selectedSessionId: null,
    tasksOpen: true,
    setTasksOpen: (update) => { context.tasksOpen = typeof update === "function" ? update(context.tasksOpen) : update; },
    projectLabels: {}, pinnedProjects: new Set(), highlightedProjectRoot: null,
    projectPathKey: (root) => root, projectDefaultLabel: (root) => root,
    visibleThreadRoots, FolderIcon() {}, SidebarMoreMenu() {}, SessionTreeItem() {},
    runningSessionIds: new Set(), unreadSessionIds: new Set(), pinnedSessionIds: new Set(),
    pinsReady: true, pinsBusy: false, handleSelectSessionFromList() {}, loadSessions() {},
    handleSessionDeleted() {}, toggleSessionPin() {},
    createNewSession: (root) => created.push(root),
    setCollapsedProjects: (update) => { context.collapsedProjects = update(context.collapsedProjects); },
    setProjectVisibleCounts: (update) => { context.projectVisibleCounts = update(context.projectVisibleCounts); },
  };
  const created = [];
  const render = runInNewContext(compiled, context);
  return { render, context, created, errors };
}

test("project name toggles history and resets pagination without selecting or creating a thread", () => {
  const { render, created } = projectGroupHarness();
  const group = { ...historyGroup(), root: "/project" };
  const main = (tree) => tree.children[0].children[0];
  const history = (tree) => tree.children[1];
  let tree = render(group);
  assert.equal(main(tree).props["aria-expanded"], true);
  assert.equal(main(tree).children[0].props.open, true);
  assert.equal(history(tree).children[0].length, 5);
  history(tree).children[1].props.onClick();
  tree = render(group);
  assert.equal(history(tree).children[0].length, 15);
  main(tree).props.onClick();
  tree = render(group);
  assert.equal(main(tree).props["aria-expanded"], false);
  assert.equal(main(tree).children[0].props.open, false);
  assert.equal(history(tree), false);
  main(tree).props.onClick();
  tree = render(group);
  assert.equal(history(tree).children[0].length, 5);
  history(tree).children[1].props.onClick();
  tree = render(group);
  history(tree).children[1].props.onClick();
  tree = render(group);
  assert.equal(history(tree).children[0].length, 20);
  assert.equal(history(tree).children[1], false);
  assert.deepEqual(created, []);
  tree.children[0].children[2].props.onClick();
  assert.deepEqual(created, ["/project"]);
  tree = render({ root: "/empty", roots: [], sessions: [] });
  assert.equal(main(tree).children[0].props.open, true);
  assert.equal(history(tree).children[0].length, 0);
  main(tree).props.onClick();
  tree = render({ root: "/empty", roots: [], sessions: [] });
  assert.equal(main(tree).children[0].props.open, false);
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
  const pinnedSection = source.slice(source.indexOf('<section className="pinned-section"'), source.indexOf('{projectsOpen && visibleProjectGroups.map((group) => renderProjectGroup(group))}'));
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
  assert.match(source, /const unpinnedProjectGroups = useMemo\(\(\) => projectGroups\.filter\(\(group\) =>\s*projectPathKey\(group\.root\) !== projectPathKey\(defaultWorkspace \?\? ""\) && !pinnedProjects\.has\(projectPathKey\(group\.root\)\)/);
  assert.match(source, /const visible = unpinnedProjectGroups\.slice\(0, 5\);/);
  assert.match(source, /const selected = unpinnedProjectGroups\.find/);
  assert.match(source, /Show \$\{unpinnedProjectGroups\.length - 5\} more projects/);
});

test("pinned projects retain the same history renderer and controls", () => {
  assert.match(source, /renderProjectGroup\(projectGroups\.find/);
  assert.match(source, /visibleProjectGroups\.map\(\(group\) => renderProjectGroup\(group\)\)/);
  assert.match(source, /className=\{isTasks \? "tasks-section" : "project-section"\}/);
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

test("Tasks toggles independently, resets pagination, and creates threads in the default workspace", async () => {
  const requests = [];
  const cwd = "C:/Users/test/.weclio/default-workspace/";
  const { render, context, created, errors } = projectGroupHarness(async (url, options) => {
    requests.push({ url, method: options?.method });
    return { ok: true, json: async () => ({ cwd }) };
  });
  const group = { ...historyGroup(), root: "C:/Users/test/.weclio/default-workspace" };
  context.collapsedProjects[group.root] = true;
  const heading = (tree) => tree.children[0];
  const toggle = (tree) => heading(tree).children[0];
  const history = (tree) => tree.children[1];
  let tree = render(group, true);
  assert.equal(tree.props.className, "tasks-section");
  assert.equal(tree.props["aria-label"], "Tasks");
  assert.equal(toggle(tree).children[1].children[0], "Tasks");
  assert.equal(toggle(tree).props["aria-expanded"], true);
  assert.equal(toggle(tree).children[0].props.className, "is-open");
  assert.equal(heading(tree).children.length, 2, "Tasks has only a toggle and a right-hand plus, not project actions");
  assert.equal(heading(tree).children[1].props["aria-label"], "New thread in Tasks");
  assert.equal(heading(tree).children[1].children[0], "+");
  assert.equal(history(tree).children[0].length, 5);
  history(tree).children[1].props.onClick();
  tree = render(group, true);
  assert.equal(history(tree).children[0].length, 15);
  toggle(tree).props.onClick();
  tree = render(group, true);
  assert.equal(toggle(tree).props["aria-expanded"], false);
  assert.equal(toggle(tree).children[0].props.className, "");
  assert.equal(history(tree), false);
  assert.equal(context.projectVisibleCounts[group.root], 5);
  assert.deepEqual(created, [], "collapse never creates a thread");
  toggle(tree).props.onClick();
  tree = render(group, true);
  assert.equal(history(tree).children[0].length, 5);
  toggle(tree).props.onClick();
  tree = render(group, true);
  await heading(tree).children[1].props.onClick();
  tree = render(group, true);
  assert.equal(toggle(tree).props["aria-expanded"], true);
  assert.deepEqual(requests, [{ url: "/api/cwd/default", method: "POST" }]);
  assert.deepEqual(created, [cwd], "creation uses the ensured directory returned by the server");
  assert.deepEqual(errors, []);
  assert.equal(context.collapsedProjects[group.root], true, "Tasks does not mutate project collapse state");
});

test("Tasks directory failures surface an error without creating a thread or expanding history", async () => {
  const cases = [
    { response: { ok: false, status: 500, json: async () => ({ error: "Cannot create directory" }) }, message: /Cannot create directory/ },
    { response: { ok: true, status: 200, json: async () => ({}) }, message: /HTTP 200/ },
    { cause: new Error("Network unavailable"), message: /Network unavailable/ },
  ];
  for (const { response, cause, message } of cases) {
    const { render, context, created, errors } = projectGroupHarness(async () => {
      if (cause) throw cause;
      return response;
    });
    context.tasksOpen = false;
    const tree = render({ root: "/workspace", roots: [], sessions: [] }, true);
    await tree.children[0].children[1].props.onClick();
    assert.deepEqual(created, []);
    assert.equal(context.tasksOpen, false);
    assert.equal(errors.length, 1);
    assert.match(errors[0], message);
  }
});

test("Tasks titles load only for visible history even when Projects is collapsed", async () => {
  const group = { ...historyGroup(), root: "/workspace" };
  const catalog = group.sessions.map((session) => ({ ...session, modified: "revision", titleLoaded: false }));
  const requests = [];
  const harness = titleLoaderHarness(async (url, options) => {
    if (url === "/api/cwd/default") return { ok: true, json: async () => ({ cwd: group.root }) };
    if (options?.method === "POST") {
      const { ids } = JSON.parse(options.body);
      requests.push(ids);
      return { ok: true, json: async () => ({ titles: ids.map((id) => ({ id, name: id, firstMessage: "" })) }) };
    }
    return { ok: true, json: async () => ({ sessions: catalog }) };
  }, {
    normalizedSessionSearch: "", projectsOpen: false, tasksGroup: group,
    collapsedProjects: { [group.root]: true },
  });
  await harness.current.loadSessions();
  await harness.settle();
  assert.equal(harness.current.defaultWorkspace, group.root);
  assert.deepEqual(requests, [group.roots.slice(0, 5).map((node) => node.session.id)]);
  harness.update({ tasksOpen: false, projectVisibleCounts: { [group.root]: 15 } });
  await harness.settle();
  assert.equal(requests.length, 1, "collapsed Tasks must not hydrate hidden titles");
  harness.update({ tasksOpen: true });
  await harness.settle();
  assert.deepEqual(requests[1], group.roots.slice(5, 15).map((node) => node.session.id));
  harness.update({ projectVisibleCounts: { [group.root]: 25 } });
  await harness.settle();
  assert.deepEqual(requests[2], [...group.roots.slice(15).map((node) => node.session.id), "child"]);
});

test("default workspace path aliases are Tasks, never project rows or project pins", () => {
  const ast = ts.createSourceFile("SessionSidebar.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const component = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "SessionSidebar");
  const names = new Set(["visiblePins", "tasksGroup", "unpinnedProjectGroups"]);
  const statements = component.body.statements.filter((node) => ts.isVariableStatement(node)
    && names.has(node.declarationList.declarations[0].name.getText(ast)));
  const compiled = ts.transpileModule(`(function () {
    ${ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "buildSessionTree").getText(ast)}
    ${statements.map((node) => node.getText(ast)).join("\n")}
    return { visiblePins, tasksGroup, unpinnedProjectGroups };
  })()`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const task = { id: "task", cwd: "C:/Users/Test/Workspace", name: "Pinned task", firstMessage: "" };
  const workspace = { root: "C:\\Users\\Test\\Workspace\\", sessions: [task], roots: [] };
  const child = { id: "child", cwd: "c:/users/test/workspace/", parentSessionId: task.id, modified: "2026-01-02" };
  const alias = { root: child.cwd, sessions: [child], roots: [] };
  const project = { root: "C:/real-project", sessions: [], roots: [] };
  const pinned = { root: "C:/pinned-project", sessions: [], roots: [] };
  for (const defaultWorkspace of ["c:/users/test/workspace", "C:\\USERS\\TEST\\WORKSPACE\\"]) {
    const result = runInNewContext(compiled, {
      useMemo: (callback) => callback(), projectPathKey, isProjectFolderHidden, sessionDisplayTitle,
      defaultWorkspace, projectGroups: [workspace, alias, project, pinned],
      allSessions: [task], hiddenProjectFolders: [], normalizedSessionSearch: "", projectLabels: {},
      projectDefaultLabel: (root) => root,
      pinnedProjects: new Set([projectPathKey(pinned.root)]),
      pins: [
        { type: "project", id: "C:/USERS/TEST/WORKSPACE/" },
        { type: "project", id: pinned.root },
        { type: "session", id: task.id },
      ],
    });
    assert.equal(result.tasksGroup.root, defaultWorkspace);
    assert.deepEqual(Array.from(result.tasksGroup.sessions), [task, child]);
    assert.equal(result.tasksGroup.roots.length, 1);
    assert.equal(result.tasksGroup.roots[0].session, task);
    assert.equal(result.tasksGroup.roots[0].children[0].session, child);
    assert.deepEqual(Array.from(result.unpinnedProjectGroups), [project]);
    assert.deepEqual(Array.from(result.visiblePins, ({ pin }) => pin.id), [pinned.root, task.id], "individual Tasks threads may still be pinned");
  }
});

test("Tasks uses the shared history renderer above Projects", () => {
  const tasks = source.indexOf("renderProjectGroup(tasksGroup, true)");
  const projects = source.indexOf("<span>Projects</span>");
  assert.ok(tasks > source.indexOf("<span>Pinned</span>") && tasks < projects);
  assert.match(source, /function renderProjectGroup\([^\n]+isTasks = false\)/);
  assert.match(source, /visibleProjectGroups\.map\(\(group\) => renderProjectGroup\(group\)\)/, "map's numeric index must not become isTasks");
});

test("section headings reveal controls on hover or keyboard focus and retain collapsed arrows", () => {
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  const rule = (selector) => {
    const match = rules.find(([, selectors]) => selectors.split(",").map((value) => value.trim()).includes(selector));
    assert.ok(match, `Missing CSS rule for ${selector}`);
    return match[2];
  };
  for (const selector of [".sidebar-section-heading:hover", ".sidebar-section-heading:focus-within"]) {
    assert.match(rule(selector), /background:\s*var\(--bg-hover\)/);
  }
  for (const selector of [
    ".sidebar-section-heading .projects-add",
    '.sidebar-section-heading .projects-heading-label[aria-expanded="true"] svg',
  ]) {
    assert.match(rule(selector), /opacity:\s*0\s*;/);
  }
  for (const selector of [
    ".sidebar-section-heading:hover .projects-add",
    ".sidebar-section-heading:focus-within .projects-add",
    ".sidebar-section-heading:hover .projects-heading-label svg",
    ".sidebar-section-heading:focus-within .projects-heading-label svg",
    '.sidebar-section-heading .projects-heading-label[aria-expanded="false"] svg',
  ]) {
    assert.match(rule(selector), /opacity:\s*1\s*;/);
  }
  assert.match(rule(".sidebar-section-heading .projects-heading-label"), /flex:\s*1\s*;/);
  const touchRule = css.match(/@media\s*\(hover:\s*none\)\s*\{([^}]+\{[^}]+\})\s*\}/)?.[1];
  assert.ok(touchRule, "touch users must not need hover to discover controls");
  assert.match(touchRule, /\.sidebar-section-heading \.projects-add/);
  assert.match(touchRule, /\.projects-heading-label\[aria-expanded="true"\] svg/);
  assert.match(touchRule, /opacity:\s*1\s*;/);
});

test("Tasks and project threads share the same indentation", () => {
  assert.match(css, /\.project-sessions\s*,\s*\.tasks-sessions\s*\{\s*margin-top:\s*0;\s*\}/);
  assert.match(css, /\.project-sessions \.session-tree-item\s*,\s*\.tasks-sessions \.session-tree-item\s*\{\s*margin-left:\s*20px;\s*\}/);
});

test("does not register row-level session deletion shortcuts", () => {
  assert.doesNotMatch(sessionItemSource, /const handleKeyDown/);
  assert.doesNotMatch(sessionItemSource, /onKeyDown=\{handleKeyDown\}/);
  assert.doesNotMatch(sessionItemSource, /tabIndex=\{0\}/);
});
