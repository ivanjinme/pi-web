import assert from "node:assert/strict";
import test from "node:test";

import { findProviderMissingModelBaseUrl, normalizeOptionalString } from "./models-config-import.ts";

test("normalizes empty imported URLs away", () => {
  assert.equal(normalizeOptionalString(""), undefined);
  assert.equal(normalizeOptionalString("   "), undefined);
  assert.equal(normalizeOptionalString(" https://example.com/v1 "), "https://example.com/v1");
});

test("requires a usable base URL for every imported model", () => {
  assert.equal(findProviderMissingModelBaseUrl({ azure: { models: [{}, {}] } }), "azure");
  assert.equal(findProviderMissingModelBaseUrl({ shared: { baseUrl: "https://example.com", models: [{}] } }), undefined);
  assert.equal(findProviderMissingModelBaseUrl({ regional: { models: [{ baseUrl: "https://us.example.com" }] } }), undefined);
});
