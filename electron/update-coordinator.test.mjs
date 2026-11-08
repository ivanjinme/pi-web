import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createUpdateCoordinator } from "./update-coordinator.mjs";

const downloaded = (version, kind) => ({ status: "downloaded", version, ...(kind ? { kind } : {}) });
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

function fixture(t, { application = true, period, timerHandle } = {}) {
  let coordinator;
  const calls = [];
  const states = [];
  const intervals = [];
  const cleared = [];
  function service(source) {
    const errors = new EventEmitter();
    let state = { status: "idle" };
    const instance = {
      installable: true,
      checkWith: async () => instance.emit({ status: "idle" }),
      verifyWith: async () => {},
      installWith: async () => {},
      stopWith: () => {},
      emit(next) { state = { ...next }; coordinator.receive(source, next); },
      snapshot(next) { state = { ...next }; },
      getState() { return { ...state }; },
      start() { assert.fail("The coordinator must never start child polling"); },
      async check() { calls.push(`${source}:check`); await instance.checkWith(); },
      canInstall() { return instance.installable && state.status === "downloaded"; },
      async verifyForInstall() { calls.push(`${source}:verify`); await instance.verifyWith(); },
      quitAndInstall() { calls.push(`${source}:install`); return instance.installWith(); },
      onInstallError(listener) {
        calls.push(`${source}:subscribe`);
        errors.on("install-error", listener);
        return () => { calls.push(`${source}:unsubscribe`); errors.off("install-error", listener); };
      },
      error: (error) => errors.emit("install-error", error),
      listenerCount: () => errors.listenerCount("install-error"),
      stop() { calls.push(`${source}:stop`); instance.stopWith(); },
    };
    return instance;
  }
  const legacy = service("legacy");
  const app = application ? service("application") : undefined;
  coordinator = createUpdateCoordinator({
    legacy, application: app,
    publish: (state) => states.push(state),
    setTimer: (callback, milliseconds) => {
      const handle = timerHandle === undefined ? { unref() { calls.push("timer:unref"); } } : timerHandle;
      intervals.push({ callback, milliseconds, handle });
      return handle;
    },
    clearTimer: (handle) => cleared.push(handle),
    ...(period === undefined ? {} : { period }),
  });
  t.after(() => coordinator.stop());
  return { coordinator, legacy, application: app, calls, states, intervals, cleared };
}

function readyApp(h) {
  h.application.checkWith = async () => h.application.emit(downloaded("2.0.0", "application"));
}

function readyLegacy(h) {
  h.legacy.checkWith = async () => h.legacy.emit(downloaded("3.0.0"));
}

test("construction does not read, start or check services; ordinary stop never installs", (t) => {
  const h = fixture(t);
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.intervals, []);
  assert.deepEqual(h.coordinator.getState(), { status: "idle" });
  assert.equal(h.coordinator.canInstall(), false);
  h.coordinator.stop();
  assert.deepEqual(h.calls, ["legacy:stop", "application:stop"]);
  assert.deepEqual(h.cleared, []);
});

test("legacy downloaded shell takes priority, without checking or installing application", async (t) => {
  const h = fixture(t);
  readyLegacy(h);
  readyApp(h);
  await h.coordinator.check();
  assert.deepEqual(h.calls, ["legacy:check"]);
  assert.deepEqual(h.coordinator.getState(), downloaded("3.0.0"));
  assert.equal(h.coordinator.canInstall(), true);
  await h.coordinator.check();
  assert.deepEqual(h.calls, ["legacy:check"]);
});

test("a legacy ready snapshot without callbacks still blocks the application check", async (t) => {
  const h = fixture(t);
  h.legacy.checkWith = async () => h.legacy.snapshot(downloaded("3.0.0"));
  await h.coordinator.check();
  assert.deepEqual(h.calls, ["legacy:check"]);
  assert.deepEqual(h.coordinator.getState(), downloaded("3.0.0"));
});

test("application follows legacy idle and routes progress, preparation and downloaded state", async (t) => {
  const h = fixture(t);
  const progress = [
    { status: "checking" },
    { status: "downloading", phase: "download", version: "2.0.0", progress: 10 },
    { status: "preparing", phase: "extracting", version: "2.0.0" },
    { status: "preparing", phase: "verifying", version: "2.0.0", progress: 100 },
    downloaded("2.0.0", "application"),
  ];
  h.application.checkWith = async () => { for (const state of progress) h.application.emit(state); };
  await h.coordinator.check();
  assert.deepEqual(h.calls, ["legacy:check", "application:check"]);
  for (const state of progress) assert.ok(h.states.some((actual) => JSON.stringify(actual) === JSON.stringify(state)));
  assert.deepEqual(h.coordinator.getState(), progress.at(-1));
  assert.equal(h.coordinator.canInstall(), true);
  h.legacy.emit({ status: "idle" });
  h.legacy.emit({ status: "downloading", version: "9.0.0", progress: 90 });
  h.legacy.emit(downloaded("9.0.0"));
  assert.deepEqual(h.coordinator.getState(), progress.at(-1));
});

test("only currently checked source may publish checking, error, download and preparation states", async (t) => {
  const h = fixture(t);
  h.legacy.checkWith = async () => {
    h.legacy.emit({ status: "checking" });
    h.application.emit({ status: "error", version: "late-app" });
    h.application.emit({ status: "preparing", version: "late-app" });
    h.application.emit(downloaded("9.0.0", "application"));
    assert.deepEqual(h.coordinator.getState(), { status: "checking" });
    h.legacy.emit({ status: "idle" });
  };
  h.application.checkWith = async () => {
    h.application.emit({ status: "downloading", version: "2.0.0", progress: 20 });
    for (const status of ["checking", "idle", "error", "downloading", "preparing"]) h.legacy.emit({ status, version: "late-legacy" });
    assert.deepEqual(h.coordinator.getState(), { status: "downloading", version: "2.0.0", progress: 20 });
    h.application.emit({ status: "error", version: "2.0.0" });
  };
  await h.coordinator.check();
  assert.deepEqual(h.coordinator.getState(), { status: "error", version: "2.0.0" });
  assert.ok(!JSON.stringify(h.states).includes("late-"));
  const count = h.states.length;
  h.legacy.emit({ status: "error" });
  h.application.emit({ status: "preparing" });
  assert.equal(h.states.length, count);
});

test("application error snapshots stay visible and do not block the next retry", async (t) => {
  const h = fixture(t);
  h.application.checkWith = async () => h.application.snapshot({ status: "error", version: "2.0.0" });
  await h.coordinator.check();
  assert.deepEqual(h.coordinator.getState(), { status: "error", version: "2.0.0" });
  assert.equal(h.coordinator.canInstall(), false);
  readyApp(h);
  await h.coordinator.check();
  assert.deepEqual(h.calls, ["legacy:check", "application:check", "legacy:check", "application:check"]);
  assert.deepEqual(h.coordinator.getState(), downloaded("2.0.0", "application"));
});

test("published, received and returned snapshots cannot mutate coordinator state", async (t) => {
  const h = fixture(t);
  const state = downloaded("2.0.0", "application");
  h.coordinator.receive("application", state);
  state.status = "error";
  h.states[0].version = "bad";
  h.coordinator.getState().status = "idle";
  assert.deepEqual(h.coordinator.getState(), downloaded("2.0.0", "application"));
  await h.coordinator.check();
  assert.deepEqual(h.calls, []);
});

test("a received download-only legacy preview is visible and has shell priority", async (t) => {
  const h = fixture(t);
  h.legacy.installable = false;
  h.legacy.emit(downloaded("3.0.0"));
  readyApp(h);
  await h.coordinator.check();
  assert.deepEqual(h.coordinator.getState(), downloaded("3.0.0"));
  assert.equal(h.coordinator.canInstall(), false);
  await assert.rejects(h.coordinator.quitAndInstall(), /not verified/);
  assert.deepEqual(h.calls, []);
});

test("a preview found by the legacy check prevents an application download", async (t) => {
  const h = fixture(t);
  h.legacy.installable = false;
  readyLegacy(h);
  readyApp(h);
  await h.coordinator.check();
  assert.deepEqual(h.calls, ["legacy:check"]);
  assert.equal(h.coordinator.canInstall(), false);
  await assert.rejects(h.coordinator.verifyForInstall(), /download-only/);
  assert.equal(h.coordinator.getState().status, "error");
});

test("check is single-flight across both services, including the handoff between them", async (t) => {
  const h = fixture(t);
  const legacyEntered = deferred();
  const legacyFinish = deferred();
  const appEntered = deferred();
  const appFinish = deferred();
  h.legacy.checkWith = async () => { legacyEntered.resolve(); await legacyFinish.promise; h.legacy.emit({ status: "idle" }); };
  h.application.checkWith = async () => { appEntered.resolve(); await appFinish.promise; h.application.emit({ status: "idle" }); };
  const pending = h.coordinator.check();
  assert.equal(h.coordinator.check(), pending);
  await legacyEntered.promise;
  assert.equal(h.coordinator.check(), pending);
  assert.deepEqual(h.calls, ["legacy:check"]);
  legacyFinish.resolve();
  await appEntered.promise;
  assert.equal(h.coordinator.check(), pending);
  assert.deepEqual(h.calls, ["legacy:check", "application:check"]);
  appFinish.resolve();
  await pending;
  await h.coordinator.check();
  assert.deepEqual(h.calls, ["legacy:check", "application:check", "legacy:check", "application:check"]);
});

test("start owns exactly one unref'd four-hour interval and does not start child timers", async (t) => {
  const h = fixture(t);
  h.coordinator.start();
  h.coordinator.start();
  await h.coordinator.check();
  assert.equal(h.intervals.length, 1);
  assert.equal(h.intervals[0].milliseconds, 4 * 60 * 60 * 1000);
  assert.deepEqual(h.calls, ["timer:unref", "legacy:check", "application:check"]);
  h.intervals[0].callback();
  h.intervals[0].callback();
  await h.coordinator.check();
  assert.deepEqual(h.calls, ["timer:unref", "legacy:check", "application:check", "legacy:check", "application:check"]);
  h.coordinator.stop();
  h.coordinator.stop();
  assert.deepEqual(h.cleared, [h.intervals[0].handle]);
});

test("custom periods and a zero-valued timer handle are supported", async (t) => {
  const h = fixture(t, { period: 25, timerHandle: 0 });
  h.coordinator.start();
  h.coordinator.start();
  await h.coordinator.check();
  h.coordinator.stop();
  assert.equal(h.intervals.length, 1);
  assert.equal(h.intervals[0].milliseconds, 25);
  assert.deepEqual(h.cleared, [0]);
});

for (const source of ["legacy", "application"]) {
  test(`${source} verification and explicit installation delegate to the same ready service`, async (t) => {
    const h = fixture(t);
    const service = h[source];
    if (source === "legacy") readyLegacy(h); else readyApp(h);
    await h.coordinator.check();
    await assert.rejects(h.coordinator.quitAndInstall(), /not verified/);
    await h.coordinator.verifyForInstall();
    h.coordinator.receive(source === "legacy" ? "application" : "legacy", downloaded("99.0.0"));
    const unsubscribe = h.coordinator.onInstallError(() => assert.fail("No failure expected"));
    await h.coordinator.quitAndInstall();
    unsubscribe();
    assert.ok(h.calls.includes(`${source}:verify`));
    assert.ok(h.calls.includes(`${source}:install`));
    const other = source === "legacy" ? "application" : "legacy";
    assert.ok(!h.calls.some((call) => call === `${other}:verify` || call === `${other}:install` || call === `${other}:subscribe`));
    assert.equal(service.listenerCount(), 0);
    await assert.rejects(h.coordinator.quitAndInstall(), /not verified/);
  });

  test(`${source} verification failure revokes selection and preserves its error snapshot for retry`, async (t) => {
    const h = fixture(t);
    const service = h[source];
    if (source === "legacy") readyLegacy(h); else readyApp(h);
    await h.coordinator.check();
    const error = new Error("Verification failed");
    service.verifyWith = async () => { service.emit({ status: "error", version: "2.0.0", phase: "verifying" }); throw error; };
    await assert.rejects(h.coordinator.verifyForInstall(), (failure) => failure === error);
    assert.deepEqual(h.coordinator.getState(), { status: "error", version: "2.0.0", phase: "verifying" });
    assert.equal(h.coordinator.canInstall(), false);
    await assert.rejects(h.coordinator.quitAndInstall(), /not verified/);
    service.verifyWith = async () => {};
    await h.coordinator.check();
    await h.coordinator.verifyForInstall();
    assert.equal(h.coordinator.canInstall(), true);
  });
}

test("verification failure with an underlying legacy idle snapshot stays idle", async (t) => {
  const h = fixture(t);
  readyLegacy(h);
  await h.coordinator.check();
  h.legacy.verifyWith = async () => { h.legacy.emit({ status: "idle" }); throw new Error("Bad file"); };
  await assert.rejects(h.coordinator.verifyForInstall(), /Bad file/);
  assert.deepEqual(h.coordinator.getState(), { status: "idle" });
  assert.equal(h.coordinator.canInstall(), false);
});

test("legacy asynchronous spawn failure delegates listeners and allows a checked retry", async (t) => {
  const h = fixture(t);
  readyLegacy(h);
  await h.coordinator.check();
  await h.coordinator.verifyForInstall();
  const received = [];
  const unsubscribe = h.coordinator.onInstallError((error) => received.push(error));
  await h.coordinator.quitAndInstall();
  const error = new Error("Spawn failed");
  h.legacy.error(error);
  assert.deepEqual(received, [error]);
  assert.equal(h.coordinator.canInstall(), false);
  assert.deepEqual(h.coordinator.getState(), { status: "error", version: "3.0.0" });
  await assert.rejects(h.coordinator.quitAndInstall(), /not verified/);
  unsubscribe();
  unsubscribe();
  assert.equal(h.legacy.listenerCount(), 0);
  h.legacy.error(new Error("Unsubscribed"));
  assert.equal(received.length, 1);
  await h.coordinator.check();
  assert.equal(h.coordinator.canInstall(), true);
  await h.coordinator.verifyForInstall();
});

test("application async apply is awaited; rejection propagates and revokes selection", async (t) => {
  const h = fixture(t);
  readyApp(h);
  const finish = deferred();
  h.application.installWith = async () => { await finish.promise; h.application.snapshot({ status: "error", version: "2.0.0" }); throw new Error("Apply failed"); };
  await h.coordinator.check();
  await h.coordinator.verifyForInstall();
  let settled = false;
  const pending = h.coordinator.quitAndInstall();
  pending.finally(() => { settled = true; }).catch(() => {});
  await Promise.resolve();
  assert.equal(settled, false);
  finish.resolve();
  await assert.rejects(pending, /Apply failed/);
  assert.deepEqual(h.coordinator.getState(), { status: "error", version: "2.0.0" });
  assert.equal(h.coordinator.canInstall(), false);
  await h.coordinator.check();
  assert.equal(h.coordinator.canInstall(), true);
});

for (const source of ["legacy", "application"]) {
  test(`stop cancels both children during ${source} check and suppresses late events`, async (t) => {
    const h = fixture(t);
    const entered = deferred();
    const finish = deferred();
    h[source].checkWith = async () => { entered.resolve(); await finish.promise; h[source].emit(downloaded("2.0.0")); };
    h[source].stopWith = () => finish.resolve();
    const pending = h.coordinator.check();
    await entered.promise;
    const published = h.states.length;
    h.coordinator.stop();
    await pending;
    h.legacy.emit(downloaded("99.0.0"));
    h.application.emit({ status: "error" });
    await h.coordinator.check();
    h.coordinator.start();
    assert.equal(h.states.length, published);
    assert.equal(h.coordinator.canInstall(), false);
    assert.equal(h.intervals.length, 0);
    assert.equal(h.calls.filter((call) => call === "legacy:stop").length, 1);
    assert.equal(h.calls.filter((call) => call === "application:stop").length, 1);
    assert.ok(!h.calls.some((call) => call.endsWith(":install")));
    if (source === "legacy") assert.ok(!h.calls.includes("application:check"));
  });
}

test("stop revokes verified readiness, unsubscribes legacy recovery, and never installs on exit", async (t) => {
  const h = fixture(t);
  readyLegacy(h);
  await h.coordinator.check();
  await h.coordinator.verifyForInstall();
  const received = [];
  const unsubscribe = h.coordinator.onInstallError((error) => received.push(error));
  assert.equal(h.legacy.listenerCount(), 1);
  h.coordinator.stop();
  unsubscribe();
  assert.equal(h.legacy.listenerCount(), 0);
  h.legacy.error(new Error("After stop"));
  assert.deepEqual(received, []);
  assert.equal(h.coordinator.canInstall(), false);
  await assert.rejects(h.coordinator.verifyForInstall(), /not ready/);
  await assert.rejects(h.coordinator.quitAndInstall(), /not verified/);
  assert.ok(!h.calls.some((call) => call.endsWith(":install")));
});

test("stop during verification cannot grant late installation permission", async (t) => {
  const h = fixture(t);
  readyApp(h);
  const entered = deferred();
  const finish = deferred();
  h.application.verifyWith = async () => { entered.resolve(); await finish.promise; };
  await h.coordinator.check();
  const pending = h.coordinator.verifyForInstall();
  await entered.promise;
  const published = h.states.length;
  h.coordinator.stop();
  finish.resolve();
  await assert.rejects(pending, /selection changed/);
  assert.equal(h.states.length, published);
  await assert.rejects(h.coordinator.quitAndInstall(), /not verified/);
});

test("legacy-only coordinator and empty subscriptions retain the service protocol", async (t) => {
  const h = fixture(t, { application: false });
  const unsubscribe = h.coordinator.onInstallError(() => assert.fail());
  unsubscribe();
  await assert.rejects(h.coordinator.verifyForInstall(), /not ready/);
  await h.coordinator.check();
  assert.deepEqual(h.calls, ["legacy:check"]);
  assert.deepEqual(h.coordinator.getState(), { status: "idle" });
  h.coordinator.stop();
});

test("unexpected check rejection exposes an error and does not poison later checks", async (t) => {
  const h = fixture(t);
  h.application.checkWith = async () => { throw new Error("Internal failure with private details"); };
  await h.coordinator.check();
  assert.deepEqual(h.coordinator.getState(), { status: "error" });
  readyApp(h);
  await h.coordinator.check();
  assert.deepEqual(h.coordinator.getState(), downloaded("2.0.0", "application"));
});

test("release index availability skips the shell channel and checks only the application channel", async (t) => {
  const states = [];
  const checked = [];
  const services = (source) => ({
    getState: () => ({ status: "idle" }),
    check: async () => { checked.push(source); },
    canInstall: () => false,
    verifyForInstall: async () => {},
    onInstallError: () => () => {},
    quitAndInstall: async () => {},
    stop: () => {},
  });
  const coordinator = createUpdateCoordinator({
    legacy: services("legacy"), application: services("application"),
    publish: (state) => states.push(state),
    refresh: async () => {},
    available: () => ({ legacy: false, application: true }),
  });
  t.after(() => coordinator.stop());
  await coordinator.check();
  assert.deepEqual(checked, ["application"], "an index without an installer must skip the shell channel");
});

test("release index with no sections ends idle without touching either channel", async (t) => {
  const checked = [];
  const coordinator = createUpdateCoordinator({
    legacy: { getState: () => ({ status: "idle" }), check: async () => { checked.push("legacy"); }, canInstall: () => false, verifyForInstall: async () => {}, onInstallError: () => () => {}, quitAndInstall: async () => {}, stop: () => {} },
    application: { getState: () => ({ status: "idle" }), check: async () => { checked.push("application"); }, canInstall: () => false, verifyForInstall: async () => {}, onInstallError: () => () => {}, quitAndInstall: async () => {}, stop: () => {} },
    refresh: async () => {},
    available: () => ({ legacy: false, application: false }),
  });
  t.after(() => coordinator.stop());
  await coordinator.check();
  assert.deepEqual(checked, []);
  assert.deepEqual(coordinator.getState(), { status: "idle" });
});

test("a failed index refresh surfaces an error and never falls back to stale feeds", async (t) => {
  const checked = [];
  const coordinator = createUpdateCoordinator({
    legacy: { getState: () => ({ status: "idle" }), check: async () => { checked.push("legacy"); }, canInstall: () => false, verifyForInstall: async () => {}, onInstallError: () => () => {}, quitAndInstall: async () => {}, stop: () => {} },
    application: { getState: () => ({ status: "idle" }), check: async () => { checked.push("application"); }, canInstall: () => false, verifyForInstall: async () => {}, onInstallError: () => () => {}, quitAndInstall: async () => {}, stop: () => {} },
    refresh: async () => { throw new Error("Release index HTTP 500"); },
  });
  t.after(() => coordinator.stop());
  await coordinator.check();
  assert.deepEqual(checked, [], "an unverified index must not reuse previously resolved URLs");
  assert.deepEqual(coordinator.getState(), { status: "error" });
});
