import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { getDefaultWorkspacePath } from "./default-workspace.ts";

test("uses one deterministic workspace below the user home", () => {
  assert.equal(
    getDefaultWorkspacePath(undefined, "/home/tester"),
    path.join("/home/tester", ".weclio", "default-workspace"),
  );
});

test("resolves an explicit override", () => {
  const configured = path.resolve("custom-weclio-workspace");
  assert.equal(getDefaultWorkspacePath(configured, "/unused"), configured);
});
