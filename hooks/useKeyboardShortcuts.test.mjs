import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

test("global Escape leaves contenteditable menus and IME handling to the composer", async (t) => {
  let handler;
  let cleanup;
  const previousWindow = globalThis.window;
  globalThis.window = {
    addEventListener(_type, callback) { handler = callback; },
    removeEventListener() {},
  };
  const jiti = createJiti(import.meta.url, {
    virtualModules: { react: { useEffect(effect) { cleanup = effect(); } } },
  });
  const { registerAbortHandler, useGlobalKeyboardShortcuts } = await jiti.import("./useKeyboardShortcuts.ts");
  let aborted = 0;
  registerAbortHandler(() => { aborted++; });
  t.after(() => {
    cleanup();
    registerAbortHandler(null);
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  });
  useGlobalKeyboardShortcuts({});
  for (const target of [{ tagName: "DIV", isContentEditable: true }, { tagName: "SPAN", isContentEditable: true },
    { tagName: "TEXTAREA" }, { tagName: "INPUT" }]) {
    handler({ key: "Escape", target, preventDefault() { assert.fail("editable Escape must not be intercepted"); } });
  }
  assert.equal(aborted, 0);
  handler({ key: "Escape", target: { tagName: "DIV", isContentEditable: false }, preventDefault() {} });
  assert.equal(aborted, 1);
});
