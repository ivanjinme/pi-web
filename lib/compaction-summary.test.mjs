import assert from "node:assert/strict";
import test from "node:test";
import { compactionSummaryBody } from "./compaction-summary.ts";

test("strips trailing pi file metadata tags from the visible summary", () => {
  const body = compactionSummaryBody(`## Goal
Keep the important user intent.

<read-files>
/tmp/a.ts
/tmp/b.ts
</read-files>

<modified-files>
/tmp/changed.ts
</modified-files>`);

  assert.equal(body, "## Goal\nKeep the important user intent.");
});

test("leaves normal summaries unchanged", () => {
  const summary = "## Goal\nNo file metadata here.";
  assert.equal(compactionSummaryBody(summary), summary);
});

test("keeps file-like tags that are part of the summary body", () => {
  const summary = `## Critical Context
The user asked what this compact metadata means: <read-files>example</read-files>.

More summary text after the mention.`;

  assert.equal(compactionSummaryBody(summary), summary);
});
