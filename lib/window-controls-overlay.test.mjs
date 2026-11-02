import assert from "node:assert/strict";
import test from "node:test";
import { bindWindowControlsOverlay } from "./window-controls-overlay.ts";

function environment(t, overlay) {
  const attributes = new Set();
  const metadata = new Set();
  const root = {
    toggleAttribute(name, enabled) { if (enabled) attributes.add(name); else attributes.delete(name); },
    removeAttribute(name) { attributes.delete(name); },
  };
  let color = "#f8f7ff";
  const observers = [];
  const globals = {
    navigator: { windowControlsOverlay: overlay },
    document: {
      documentElement: root,
      head: { append(meta) { metadata.add(meta); } },
      createElement() { return { name: "", content: "", remove() { metadata.delete(this); } }; },
    },
    getComputedStyle: () => ({ getPropertyValue: () => color }),
    MutationObserver: class {
      constructor(callback) { this.callback = callback; }
      observe(_target, options) { assert.deepEqual(options.attributeFilter, ["class"]); observers.push(this); }
      disconnect() { this.disconnected = true; }
    },
  };
  for (const [name, value] of Object.entries(globals)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, name, previous);
      else delete globalThis[name];
    });
  }
  return {
    attributes,
    metadata,
    changeTheme(value) { color = value; observers.at(-1)?.callback(); },
    get observer() { return observers.at(-1); },
  };
}

function createOverlay(visible) {
  return Object.assign(new EventTarget(), { visible });
}

test("browsers without an overlay retain their existing document", (t) => {
  const env = environment(t);
  assert.equal(bindWindowControlsOverlay(), undefined);
  assert.equal(env.attributes.size, 0);
  assert.equal(env.metadata.size, 0);
  assert.equal(env.observer, undefined);
});

test("an available but disabled overlay does not activate desktop styles or metadata", (t) => {
  const env = environment(t, createOverlay(false));
  const cleanup = bindWindowControlsOverlay();
  assert.equal(env.attributes.size, 0);
  assert.equal(env.metadata.size, 0);
  cleanup();
});

test("overlay activation and visibility transitions synchronize styles and theme metadata", (t) => {
  const overlay = createOverlay(true);
  const env = environment(t, overlay);
  const cleanup = bindWindowControlsOverlay();
  assert.ok(env.attributes.has("data-window-controls-overlay"));
  assert.equal(env.metadata.size, 1);
  assert.equal([...env.metadata][0].name, "theme-color");
  assert.equal([...env.metadata][0].content, "#f8f7ff");

  overlay.visible = false;
  overlay.dispatchEvent(new Event("geometrychange"));
  assert.equal(env.attributes.size, 0);
  assert.equal(env.metadata.size, 0);

  env.changeTheme("#2e2e2e");
  overlay.visible = true;
  overlay.dispatchEvent(new Event("geometrychange"));
  assert.equal(env.metadata.size, 1);
  assert.equal([...env.metadata][0].content, "#2e2e2e");
  cleanup();
});

test("theme changes update only the owned metadata and cleanup removes all subscriptions", (t) => {
  const overlay = createOverlay(true);
  const env = environment(t, overlay);
  const cleanup = bindWindowControlsOverlay();
  const meta = [...env.metadata][0];
  env.changeTheme("#2e2e2e");
  assert.equal(meta.content, "#2e2e2e");
  assert.equal(env.metadata.size, 1);
  cleanup();
  assert.equal(env.attributes.size, 0);
  assert.equal(env.metadata.size, 0);
  assert.equal(env.observer.disconnected, true);
  overlay.dispatchEvent(new Event("geometrychange"));
  assert.equal(env.attributes.size, 0);
  assert.equal(env.metadata.size, 0);
});
