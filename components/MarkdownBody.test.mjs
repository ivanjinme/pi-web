import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { MarkdownBody } = await jiti.import("./MarkdownBody.tsx");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
const { normalizeDisplayMath } = await jiti.import("../lib/markdown.ts");

function renderMarkdown(markdown, citations) {
  return renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(MarkdownBody, {
        cwd: "/home/me/project",
        onOpenFile() {},
        citations,
      }, markdown),
    ),
  );
}

test("removes raw citation tokens and renders provider citation URLs", () => {
  const html = renderMarkdown("Claim. citeturn0search4", [{
    type: "url_citation",
    url: "https://example.com/source",
    title: "Source",
  }]);

  assert.doesNotMatch(html, /turn0search4/);
  assert.match(html, /<a href="https:\/\/example\.com\/source" target="_blank" rel="noopener noreferrer">\[1\] Source<\/a>/);
});

test("opens non-file markdown links in a safe new tab", () => {
  const html = renderMarkdown("[docs](https://example.com/docs)");

  assert.match(
    html,
    /<a (?=[^>]*href="https:\/\/example\.com\/docs")(?=[^>]*target="_blank")(?=[^>]*rel="noopener noreferrer")[^>]*>docs<\/a>/,
  );
  assert.doesNotMatch(html, /\snode=/);
});

test("keeps local file markdown links in the app", () => {
  const html = renderMarkdown("[file](components/MarkdownBody.tsx)");

  assert.match(html, /<a href="components\/MarkdownBody\.tsx">file<\/a>/);
  assert.doesNotMatch(html, /target=|rel=|\snode=/);
});

test("keeps Windows absolute file links in the app", () => {
  const html = renderMarkdown("[file](D:/work/project/HANDOFF.md)");

  assert.match(html, /<a href="file:\/\/\/D:\/work\/project\/HANDOFF\.md">file<\/a>/);
  assert.doesNotMatch(html, /target=|rel=|\snode=/);
});

test("keeps file URLs in the app", () => {
  const html = renderMarkdown("[file](file:///D:/work/project/HANDOFF.md)");

  assert.match(html, /<a href="file:\/\/\/D:\/work\/project\/HANDOFF\.md">file<\/a>/);
  assert.doesNotMatch(html, /target=|rel=|\snode=/);
});

test("renders unknown XML tags as code instead of hiding them", () => {
  const html = renderMarkdown("before <request>value</request> after");

  assert.match(html, /<code class="markdown-inline-code">&lt;request&gt;<\/code>/);
  assert.match(html, /value/);
  assert.match(html, /<code class="markdown-inline-code">&lt;\/request&gt;<\/code>/);
});

test("keeps allowed raw HTML rendering normally", () => {
  const html = renderMarkdown("<strong>value</strong>");

  assert.match(html, /<strong>value<\/strong>/);
  assert.doesNotMatch(html, /&lt;strong&gt;/);
});

test("renders multiline custom XML as an XML code block", () => {
  const html = renderMarkdown("<request>\nvalue\n</request>");

  assert.match(html, /markdown-code-lang">xml/);
  assert.equal(html.match(/request/g)?.length, 2);
  assert.match(html, /value/);
  assert.doesNotMatch(html, /<\/?request>/);
});

test("renders LaTeX parenthesis delimiters as inline math", () => {
  const html = renderMarkdown(String.raw`射线为 \(r_c = K^{-1}p\)。`);

  assert.match(html, /class="katex"/);
  assert.match(html, /r_c/);
});

test("renders inline math beside a citation link", () => {
  const html = renderMarkdown(String.raw`途径修正因子 \(F_{\mathrm{route}}=100\)。[来源](https://example.com/source)`);

  assert.match(html, /class="katex"/);
  assert.match(html, /href="https:\/\/example\.com\/source"/);
});

test("renders the reported route-factor paragraph without losing its citation", () => {
  const markdown = String.raw`依据分子量646.9及XLogP 15.5，采用Boobier等的理化性质分档方法，估计经口生物利用度属于≤1%档；本评估采用**途径修正因子 \(F_{\mathrm{route}}=100\)**。这是模型分档估计，而非实测生物利用度；植入释放后的系统可利用部分按完全吸收处理。（Boobier等，2026，图1，DOI：10.1016/j.yrtph.2026.106215）[Tris(2,4-di-tert-butylphenyl) phosphite | C42H63O3P | CID 91601 - PubChem](https://pubchem.ncbi.nlm.nih.gov/compound/Irgafos%20168?utm_source=openai)`;
  const html = renderMarkdown(markdown);

  assert.match(html, /class="katex"/);
  assert.match(html, /href="https:\/\/pubchem\.ncbi\.nlm\.nih\.gov\/compound\/Irgafos%20168\?utm_source=openai"/);
  assert.doesNotMatch(html, /katex-error/);
});

test("normalizes math outside link destinations but preserves nested and escaped URL parentheses", () => {
  for (const destination of [
    String.raw`https://example.com/\(manual\)`,
    String.raw`relative/(nested/(part))/\(manual\)`,
  ]) {
    const markdown = String.raw`\(x+y\) [docs](${destination}) \(z\)`;
    assert.equal(normalizeDisplayMath(markdown), `$x+y$ [docs](${destination}) $z$`);
  }
});

test("preserves bare URL delimiters while normalizing math elsewhere on the line", () => {
  const markdown = String.raw`\(x+y\) https://example.com/\(manual\) \(z\)`;
  assert.equal(normalizeDisplayMath(markdown), String.raw`$x+y$ https://example.com/\(manual\) $z$`);
});

test("renders paired LaTeX bracket delimiters as display math", () => {
  const html = renderMarkdown(String.raw`\[
P(\lambda)=o_b+\lambda r_b
\]`);
  const oneLineHtml = renderMarkdown(String.raw`\[P(\lambda)=o_b+\lambda r_b\]`);

  assert.match(html, /class="katex-display"/);
  assert.match(html, /lambda/);
  assert.match(oneLineHtml, /class="katex-display"/);
});

test("leaves an unmatched LaTeX bracket delimiter unchanged", () => {
  const markdown = String.raw`before
\[
x + y
after`;

  assert.equal(normalizeDisplayMath(markdown), markdown);
});

test("does not normalize LaTeX delimiters inside Markdown code", () => {
  const markdown = "    \\(indented\\)\n\n`code\n\\(inline\\)`\n\n```text\n\\[\nfenced\n\\]\n```";

  assert.equal(normalizeDisplayMath(markdown), markdown);
});

test("does not normalize LaTeX delimiters inside raw HTML code", () => {
  const markdown = "<code>\\(inline\\)</code>\n\n<pre>\n\\(block\\)\n</pre>";

  assert.equal(normalizeDisplayMath(markdown), markdown);
});

test("does not normalize escaped delimiters or link destinations", () => {
  const escaped = String.raw`Literal: \\(x+y\\).`;
  const link = String.raw`[docs](https://example.com/\(manual\))`;

  assert.equal(normalizeDisplayMath(escaped), escaped);
  assert.equal(normalizeDisplayMath(link), link);
});
