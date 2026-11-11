import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

test("turn changes feed the workspace without appending summary cards to the timeline", async () => {
  const source = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /TurnChangesChip|pushTurnChanges|changesByGroup|lastGroupByTurn/);
  assert.match(source, /onTurnChangesChange\?\.\(turnChanges\)/);
  assert.match(source, /<MessageView[\s\S]*?onOpenChanges=\{onOpenChanges\}[\s\S]*?changeToolCallIds=\{changeToolCallIds\}/);
});

// 首条消息会改变空态布局；编辑器不能因此卸载，否则异步提交无法恢复输入。
test("empty and active conversations share one unconditional composer mount", async () => {
  const source = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
  const ast = ts.createSourceFile("ChatWindow.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const mounts = [];
  const visit = (node) => {
    if (ts.isJsxExpression(node) && node.expression?.getText(ast) === "chatInputElement") mounts.push(node);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.equal(mounts.length, 1);
  for (let parent = mounts[0].parent; parent; parent = parent.parent) {
    assert.ok(!ts.isConditionalExpression(parent), "composer must not live in a layout ternary");
    assert.ok(!(ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken),
      "composer must not be conditionally mounted");
  }
});
