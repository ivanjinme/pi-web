#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const PATCHED_PI_AI_VERSION = "1.0.2";
const packageRoot = path.resolve(__dirname, "..");
const piAiRoot = findPackageRoot(packageRoot);
const piAiPackagePath = path.join(piAiRoot, "package.json");
const typesPath = path.join(piAiRoot, "dist", "types.d.ts");
const responsesPath = path.join(piAiRoot, "dist", "api", "openai-responses-shared.js");
const piAiPackage = JSON.parse(fs.readFileSync(piAiPackagePath, "utf8"));
const typesContent = fs.readFileSync(typesPath, "utf8");
const responsesContent = fs.readFileSync(responsesPath, "utf8");

const hasNativeCitationTypes = typesContent.includes("citations?: Citation[];");
const hasNativeCitationParsing = responsesContent.includes("url_citation") && responsesContent.includes("annotations");
if (hasNativeCitationTypes && hasNativeCitationParsing) process.exit(0);

if (piAiPackage.version !== PATCHED_PI_AI_VERSION) {
  throw new Error(
    `Unsupported @earendil-works/pi-ai version ${piAiPackage.version}; citation patch targets ${PATCHED_PI_AI_VERSION}. Update scripts/apply-pi-citation-patch.cjs before upgrading Pi.`,
  );
}

patchFile(
  typesPath,
  "export interface TextContent {\n    type: \"text\";\n    text: string;\n    textSignature?: string;\n}",
  "export interface Citation {\n    type: \"url_citation\";\n    url: string;\n    title?: string;\n    startIndex?: number;\n    endIndex?: number;\n}\nexport interface TextContent {\n    type: \"text\";\n    text: string;\n    textSignature?: string;\n    citations?: Citation[];\n}",
  "export interface Citation {",
);

patchFile(
  responsesPath,
  "function appendCustomToolCallInput(block, nextInput, close) {\n    const customInput = block.customInput;\n    if (!customInput)\n        return undefined;\n    const delta = appendGrammarToolInputJsonDelta(customInput.jsonBuffer, customInput.property, nextInput, close);\n    block.arguments = { [customInput.property]: nextInput };\n    return delta;\n}\nexport async function processResponsesStream",
  "function appendCustomToolCallInput(block, nextInput, close) {\n    const customInput = block.customInput;\n    if (!customInput)\n        return undefined;\n    const delta = appendGrammarToolInputJsonDelta(customInput.jsonBuffer, customInput.property, nextInput, close);\n    block.arguments = { [customInput.property]: nextInput };\n    return delta;\n}\nfunction extractUrlCitations(item) {\n    const citations = [];\n    for (const content of item.content ?? []) {\n        if (content.type !== \"output_text\" || !Array.isArray(content.annotations))\n            continue;\n        for (const annotation of content.annotations) {\n            if (annotation?.type !== \"url_citation\" || typeof annotation.url !== \"string\")\n                continue;\n            citations.push({\n                type: \"url_citation\",\n                url: annotation.url,\n                ...(typeof annotation.title === \"string\" ? { title: annotation.title } : {}),\n                ...(typeof annotation.start_index === \"number\" ? { startIndex: annotation.start_index } : {}),\n                ...(typeof annotation.end_index === \"number\" ? { endIndex: annotation.end_index } : {}),\n            });\n        }\n    }\n    return citations;\n}\nexport async function processResponsesStream",
  "function extractUrlCitations(item) {",
);

patchFile(
  responsesPath,
  "            else if (item.type === \"message\" && slot?.type === \"text\") {\n                slot.block.text = item.content?.map((c) => (c.type === \"output_text\" ? c.text : c.refusal)).join(\"\") || \"\";\n                slot.block.textSignature = encodeTextSignatureV1(item.id, item.phase ?? undefined);\n                stream.push({",
  "            else if (item.type === \"message\" && slot?.type === \"text\") {\n                slot.block.text = item.content?.map((c) => (c.type === \"output_text\" ? c.text : c.refusal)).join(\"\") || \"\";\n                slot.block.textSignature = encodeTextSignatureV1(item.id, item.phase ?? undefined);\n                const citations = extractUrlCitations(item);\n                if (citations.length > 0)\n                    slot.block.citations = citations;\n                stream.push({",
  "const citations = extractUrlCitations(item);",
);

function findPackageRoot(start) {
  for (let current = start;; current = path.dirname(current)) {
    const candidate = path.join(current, "node_modules", "@earendil-works", "pi-ai");
    if (fs.existsSync(path.join(candidate, "package.json"))) return candidate;
    const parent = path.dirname(current);
    if (parent === current) throw new Error("Could not find @earendil-works/pi-ai");
  }
}

function patchFile(filePath, original, replacement, patchedMarker) {
  const content = fs.readFileSync(filePath, "utf8");
  if (content.includes(patchedMarker)) return;
  if (!content.includes(original)) {
    throw new Error(`Citation patch anchor not found: ${filePath}`);
  }
  fs.writeFileSync(filePath, content.replace(original, replacement));
}
