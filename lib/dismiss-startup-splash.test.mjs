import assert from "node:assert/strict";
import test from "node:test";
import { dismissStartupSplash } from "./dismiss-startup-splash.ts";

function environment(t, reducedMotion = false) {
  const frames = new Map();
  const timers = new Map();
  let nextId = 0;
  const element = () => ({
    hidden: false,
    attributes: new Set(),
    setAttribute(name) { this.attributes.add(name); },
    removeAttribute(name) { this.attributes.delete(name); },
  });
  const splash = element();
  const content = { ...element(), inert: true };
  const oldDocument = globalThis.document;
  const oldWindow = globalThis.window;
  globalThis.document = { getElementById: (id) => id === "startup-splash" ? splash : content };
  globalThis.window = {
    matchMedia: () => ({ matches: reducedMotion }),
    requestAnimationFrame: (callback) => { frames.set(++nextId, callback); return nextId; },
    cancelAnimationFrame: (id) => frames.delete(id),
    setTimeout: (callback, ms) => { timers.set(++nextId, { callback, ms }); return nextId; },
    clearTimeout: (id) => timers.delete(id),
  };
  t.after(() => { globalThis.document = oldDocument; globalThis.window = oldWindow; });
  return {
    splash, content, frames, timers,
    frame() {
      const current = [...frames.values()];
      frames.clear();
      current.forEach((callback) => callback());
    },
  };
}

test("startup exits only after two frames, then restores input after the animation", (t) => {
  const env = environment(t);
  dismissStartupSplash();
  assert.equal(env.splash.attributes.has("data-exit"), false);
  env.frame();
  assert.equal(env.timers.size, 0);
  env.frame();
  assert.equal(env.splash.attributes.has("data-exit"), true);
  assert.equal(env.content.attributes.has("data-visible"), true);
  assert.equal(env.content.inert, true);
  const timer = [...env.timers.values()][0];
  assert.equal(timer.ms, 1500);
  timer.callback();
  assert.equal(env.splash.hidden, true);
  assert.equal(env.content.inert, false);
  assert.equal(dismissStartupSplash(), undefined);
});

test("strict-mode cleanup cancels an unfinished exit and allows another attempt", (t) => {
  const env = environment(t);
  const cancel = dismissStartupSplash();
  env.frame();
  env.frame();
  cancel();
  assert.equal(env.timers.size, 0);
  assert.equal(env.splash.attributes.has("data-exit"), false);
  assert.equal(env.content.attributes.has("data-visible"), false);
  assert.equal(env.content.inert, true);
  dismissStartupSplash();
  env.frame();
  env.frame();
  assert.equal(env.timers.size, 1);
});

test("reduced motion uses the short fade instead of the particle exit duration", (t) => {
  const env = environment(t, true);
  dismissStartupSplash();
  env.frame();
  env.frame();
  assert.equal([...env.timers.values()][0].ms, 200);
});

test("cleanup before the first paint leaves no scheduled callbacks", (t) => {
  const env = environment(t);
  const cancel = dismissStartupSplash();
  cancel();
  assert.equal(env.frames.size, 0);
  assert.equal(env.timers.size, 0);
});
