import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setImmediate as nextTurn } from "node:timers/promises";
import { closeUpdateWindow, createUpdateInstaller } from "./update-install.mjs";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

class FakeWindow extends EventEmitter {
  constructor(events, mode = "closed") {
    super();
    this.events = events;
    this.mode = mode;
    this.destroyed = false;
    this.webContents = new EventEmitter();
    this.closeStarted = deferred();
  }
  isDestroyed() { return this.destroyed; }
  close() {
    this.events.push("close");
    this.closeStarted.resolve();
    if (this.mode === "throw") throw new Error("Window close failed");
    const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    if (this.mode === "prevented") event.preventDefault();
    this.emit("close", event);
    if (this.mode === "veto") this.webContents.emit("will-prevent-unload", event);
    if (this.mode === "closed") this.acceptClose();
  }
  acceptClose() {
    this.destroyed = true;
    this.events.push("closed");
    this.emit("closed");
  }
}

function fixture({ packaged = true, canInstall = true, mode, inspect = "ready", lock = "ready", confirm, verify, install, missingGate = false } = {}) {
  const events = [];
  const dialogs = [];
  const logs = [];
  const window = new FakeWindow(events, mode);
  let currentWindow = window;
  let installError;
  let installed = 0;
  let restored = 0;
  const errorShown = deferred();
  const questionShown = deferred();
  const verifyStarted = deferred();
  const gate = {
    async inspect() { events.push("inspect"); return typeof inspect === "function" ? inspect() : inspect; },
    async lock() { events.push("lock"); return typeof lock === "function" ? lock() : lock; },
    async unlock() { events.push("unlock"); },
  };
  const service = {
    canInstall() { events.push("canInstall"); return canInstall; },
    async verifyForInstall() { events.push("verify"); verifyStarted.resolve(); return verify?.(); },
    onInstallError(callback) {
      events.push("subscribe");
      installError = callback;
      return () => { events.push("unsubscribe"); installError = undefined; };
    },
    quitAndInstall() {
      events.push("quitAndInstall");
      installed += 1;
      install?.();
    },
  };
  const installer = createUpdateInstaller({
    app: { isPackaged: packaged },
    getService: () => service,
    getWindow: () => currentWindow,
    getGate: () => missingGate ? undefined : gate,
    dialog: {
      async showMessageBox(...args) {
        const options = args.at(-1);
        dialogs.push(options);
        events.push(`dialog:${options.type}`);
        if (options.type === "error") errorShown.resolve();
        if (options.type === "question") {
          questionShown.resolve();
          return confirm ? confirm() : { response: 1 };
        }
        return { response: 0 };
      },
    },
    async restoreWindow() {
      events.push("restore");
      restored += 1;
      if (currentWindow.isDestroyed()) currentWindow = new FakeWindow(events);
    },
    log: (...args) => logs.push(args),
  });
  return {
    installer, events, dialogs, logs, window, errorShown, questionShown, verifyStarted,
    get installed() { return installed; },
    get restored() { return restored; },
    get currentWindow() { return currentWindow; },
    emitInstallError(error) { assert.equal(typeof installError, "function"); installError(error); },
  };
}

function assertWindowListenersClean(window) {
  assert.equal(window.listenerCount("closed"), 0);
  assert.equal(window.listenerCount("close"), 0);
  assert.equal(window.webContents.listenerCount("will-prevent-unload"), 0);
}

function assertPreserved(h) {
  assert.equal(h.installed, 0);
  assert.equal(h.window.isDestroyed(), false);
  assert.equal(h.currentWindow, h.window);
}

test("production ready handoff uses only the injected stock updater integration point", async () => {
  const h = fixture();
  await h.installer.restart("en");
  assert.deepEqual(h.events, ["canInstall", "inspect", "dialog:question", "lock", "verify", "close", "closed", "subscribe", "quitAndInstall"]);
  assert.equal(h.installed, 1);
  assert.equal(h.installer.isClosing(), true);
  assertWindowListenersClean(h.window);
  h.installer.dispose();
  assert.equal(h.events.at(-1), "unsubscribe");
});

test("a close request alone never installs; only the actual closed event allows handoff", async () => {
  const h = fixture({ mode: "pending" });
  const restart = h.installer.restart("en");
  await h.window.closeStarted.promise;
  assert.equal(h.installer.isClosing(), true);
  assertPreserved(h);
  await nextTurn();
  assert.equal(h.installed, 0);
  assert.equal(h.events.filter((event) => event === "inspect").length, 1);
  h.window.acceptClose();
  await restart;
  assert.equal(h.installed, 1);
  assertWindowListenersClean(h.window);
  h.installer.dispose();
});

test("busy inspection warns before confirmation without locking or polling", async () => {
  const h = fixture({ inspect: "busy" });
  await h.installer.restart("en");
  await nextTurn();
  assert.deepEqual(h.events, ["canInstall", "inspect", "dialog:warning"]);
  assertPreserved(h);
  assert.equal(h.installer.isClosing(), false);
});

test("tasks becoming busy after confirmation release the lock and never verify or close", async () => {
  const h = fixture({ lock: "busy" });
  await h.installer.restart("en");
  assert.deepEqual(h.events, ["canInstall", "inspect", "dialog:question", "lock", "unlock", "dialog:warning"]);
  assertPreserved(h);
});

test("cancelled confirmation does not acquire the gate", async () => {
  const h = fixture({ confirm: async () => ({ response: 0 }) });
  await h.installer.restart("zh-CN");
  assert.deepEqual(h.events, ["canInstall", "inspect", "dialog:question"]);
  assert.deepEqual(h.dialogs[0].buttons, ["取消", "重启更新"]);
  assertPreserved(h);
});

for (const mode of ["veto", "prevented"]) {
  test(`closeUpdateWindow returns false and cleans listeners for ${mode}`, async () => {
    const window = new FakeWindow([], mode);
    assert.equal(await closeUpdateWindow(window), false);
    assert.equal(window.isDestroyed(), false);
    assertWindowListenersClean(window);
  });

  test(`${mode} close preserves the original window and releases the gate`, async () => {
    const h = fixture({ mode });
    await h.installer.restart("en");
    assertPreserved(h);
    assert.equal(h.events.filter((event) => event === "unlock").length, 1);
    assert.equal(h.events.includes("subscribe"), false);
    assert.equal(h.dialogs.at(-1).type, "info");
    assert.equal(h.installer.isClosing(), false);
    assertWindowListenersClean(h.window);
  });
}

for (const locale of ["en", "zh-CN"]) {
  for (const kind of ["synchronous", "asynchronous"]) {
    test(`${kind} install error restores a window, unlocks, and reports ${locale} error`, async () => {
      const error = new Error("Stock updater rejected install");
      const h = fixture({ install: kind === "synchronous" ? () => { throw error; } : undefined });
      await h.installer.restart(locale);
      if (kind === "asynchronous") {
        h.emitInstallError(error);
        await h.errorShown.promise;
        await nextTurn();
      }
      assert.equal(h.installed, 1);
      assert.equal(h.restored, 1);
      assert.notEqual(h.currentWindow, h.window);
      assert.equal(h.currentWindow.isDestroyed(), false);
      assert.equal(h.events.filter((event) => event === "unlock").length, 1);
      assert.equal(h.events.filter((event) => event === "unsubscribe").length, 1);
      assert.equal(h.dialogs.at(-1).type, "error");
      assert.equal(h.dialogs.at(-1).message, locale === "zh-CN" ? "无法安装更新，请稍后重试。" : "The update could not be started. Please try again.");
      assert.equal(h.installer.isClosing(), false);
      assert.ok(h.logs.some((args) => args.includes(error.message)));
      h.installer.dispose();
    });
  }
}

for (const action of ["inspect", "lock"]) {
  for (const reason of ["Malformed desktop update gate reply", "Desktop update gate request timed out"]) {
    test(`${action} rejecting with ${reason} fails closed without closing the window`, async () => {
      const h = fixture({ [action]: async () => { throw new Error(reason); } });
      await h.installer.restart("en");
      assertPreserved(h);
      assert.equal(h.events.includes("verify"), false);
      assert.equal(h.events.includes("close"), false);
      assert.equal(h.events.filter((event) => event === "unlock").length, action === "lock" ? 1 : 0);
      assert.equal(h.dialogs.at(-1).type, "error");
    });
  }
}

test("failed verification preserves the window and releases the gate", async () => {
  const h = fixture({ verify: async () => { throw new Error("Invalid signed artifact"); } });
  await h.installer.restart("en");
  assertPreserved(h);
  assert.equal(h.events.includes("close"), false);
  assert.equal(h.events.filter((event) => event === "unlock").length, 1);
  assert.equal(h.dialogs.at(-1).type, "error");
});

test("missing task gate fails closed before asking to restart", async () => {
  const h = fixture({ missingGate: true });
  await h.installer.restart("en");
  assertPreserved(h);
  assert.deepEqual(h.events, ["canInstall", "restore", "dialog:error"]);
});

for (const options of [{ packaged: false, canInstall: true }, { packaged: true, canInstall: false }]) {
  test(`${options.packaged ? "non-installable test source" : "unpackaged app"} always stays preview-only`, async () => {
    const h = fixture(options);
    await h.installer.restart("en");
    assertPreserved(h);
    assert.deepEqual(h.events, options.packaged ? ["canInstall", "dialog:info"] : ["dialog:info"]);
    assert.match(h.dialogs[0].message, /will not install or restart/);
    assert.equal(h.installer.isClosing(), false);
  });
}

test("repeat clicks are serialized during confirmation, verification, closing, and handoff", async () => {
  const confirm = deferred();
  const verify = deferred();
  const h = fixture({ mode: "pending", confirm: () => confirm.promise, verify: () => verify.promise });
  const restart = h.installer.restart("en");
  await h.questionShown.promise;
  await h.installer.restart("zh-CN");
  confirm.resolve({ response: 1 });
  await h.verifyStarted.promise;
  await h.installer.restart("zh-CN");
  verify.resolve();
  await h.window.closeStarted.promise;
  await h.installer.restart("zh-CN");
  await nextTurn();
  assert.equal(h.installed, 0);
  h.window.acceptClose();
  await restart;
  await h.installer.restart("zh-CN");
  assert.equal(h.installed, 1);
  assert.equal(h.events.filter((event) => event === "inspect").length, 1);
  assert.equal(h.events.filter((event) => event === "lock").length, 1);
  assert.equal(h.events.filter((event) => event === "verify").length, 1);
  assert.equal(h.dialogs.length, 1);
  assert.equal(h.dialogs[0].title, "Weclio update");
  h.installer.dispose();
});

test("dispose during confirmation cancels without acquiring a lock or installing", async () => {
  const confirm = deferred();
  const h = fixture({ confirm: () => confirm.promise });
  const restart = h.installer.restart("en");
  await h.questionShown.promise;
  h.installer.dispose();
  confirm.resolve({ response: 1 });
  await restart;
  await h.installer.restart("en");
  assertPreserved(h);
  assert.deepEqual(h.events, ["canInstall", "inspect", "dialog:question"]);
});

test("dispose during verification cancels installation and releases the acquired gate", async () => {
  const verify = deferred();
  const h = fixture({ verify: () => verify.promise });
  const restart = h.installer.restart("en");
  await h.verifyStarted.promise;
  h.installer.dispose();
  verify.resolve();
  await restart;
  await h.installer.restart("en");
  assertPreserved(h);
  assert.equal(h.events.includes("close"), false);
  assert.equal(h.events.filter((event) => event === "unlock").length, 1);
});

test("closeUpdateWindow rejects a thrown close error and cleans all listeners", async () => {
  const window = new FakeWindow([], "throw");
  await assert.rejects(closeUpdateWindow(window), /Window close failed/);
  assertWindowListenersClean(window);
  assert.equal(window.isDestroyed(), false);
});

test("accepted close uses cached webContents without accessing the destroyed window getter", async () => {
  const window = new EventEmitter();
  const contents = new EventEmitter();
  let destroyed = false;
  let readsBeforeClose = 0;
  let readsAfterClose = 0;
  window.isDestroyed = () => destroyed;
  Object.defineProperty(window, "webContents", {
    get() {
      if (destroyed) {
        readsAfterClose += 1;
        throw new Error("Object has been destroyed");
      }
      readsBeforeClose += 1;
      return contents;
    },
  });
  window.close = () => { destroyed = true; window.emit("closed"); };
  assert.equal(await closeUpdateWindow(window), true);
  assert.equal(readsBeforeClose, 1);
  assert.equal(readsAfterClose, 0);
  assert.equal(window.listenerCount("closed"), 0);
  assert.equal(window.listenerCount("close"), 0);
  assert.equal(contents.listenerCount("will-prevent-unload"), 0);
});

test("thrown window close is recovered as an error, not reported as a user cancellation", async () => {
  const h = fixture({ mode: "throw" });
  await h.installer.restart("en");
  assertPreserved(h);
  assertWindowListenersClean(h.window);
  assert.equal(h.events.filter((event) => event === "unlock").length, 1);
  assert.equal(h.restored, 1);
  assert.equal(h.dialogs.at(-1).type, "error");
  assert.ok(h.logs.some((args) => args.includes("Window close failed")));
});
