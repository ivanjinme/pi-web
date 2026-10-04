import assert from "node:assert/strict";
import test from "node:test";
import { processResponsesStream } from "../node_modules/@earendil-works/pi-ai/dist/api/openai-responses-shared.js";

test("Pi Responses preserves URL citations in completed text and streaming events", async () => {
  const item = {
    type: "message",
    id: "msg_citations",
    role: "assistant",
    content: [{
      type: "output_text",
      text: "Source",
      annotations: [{
        type: "url_citation",
        url: "https://example.com/source",
        title: "Source",
        start_index: 0,
        end_index: 6,
      }],
    }],
  };
  async function* events() {
    yield { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } };
    yield { type: "response.output_item.done", output_index: 0, item };
    yield { type: "response.completed", response: { status: "completed", output: [item] } };
  }
  const output = {
    content: [],
    stopReason: "stop",
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
  const streamed = [];
  const model = { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  await processResponsesStream(events(), output, { push: (event) => streamed.push(event) }, model);
  const expected = [{
    type: "url_citation",
    url: "https://example.com/source",
    title: "Source",
    startIndex: 0,
    endIndex: 6,
  }];
  assert.equal(output.content[0].text, "Source");
  assert.deepEqual(output.content[0].citations, expected);
  assert.deepEqual(streamed.find((event) => event.type === "text_end").partial.content[0].citations, expected);
});
