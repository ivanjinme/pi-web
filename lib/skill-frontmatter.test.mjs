import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { setDisableModelInvocation } from "./skill-frontmatter.ts";

describe("setDisableModelInvocation", () => {
  const withFrontmatter = "---\nname: my-skill\ndescription: Does things\n---\n\nBody text.\n";

  it("adds the key or creates frontmatter when absent", () => {
    const updated = setDisableModelInvocation(withFrontmatter, true);
    assert.equal(parseFrontmatter(updated).frontmatter["disable-model-invocation"], true);
    assert.equal(parseFrontmatter(setDisableModelInvocation("Just a body.\n", true)).frontmatter["disable-model-invocation"], true);
  });

  it("replaces explicit false rather than creating a duplicate key", () => {
    const content = "---\nname: my-skill\ndisable-model-invocation: false\ndescription: Does things\n---\n\nBody text.\n";
    const updated = setDisableModelInvocation(content, true);
    assert.equal(parseFrontmatter(updated).frontmatter["disable-model-invocation"], true);
    assert.equal(updated.match(/^disable-model-invocation[^\n]*/gm)?.length, 1);
  });

  it("updates and removes indented quoted keys", () => {
    for (const quote of ['"', "'"]) {
      const content = `---\n  name: my-skill\n  ${quote}disable-model-invocation${quote}: false\n---\nBody text.\n`;
      const updated = setDisableModelInvocation(content, true);
      assert.equal(parseFrontmatter(updated).frontmatter["disable-model-invocation"], true);
      assert.equal(parseFrontmatter(setDisableModelInvocation(updated, false)).frontmatter["disable-model-invocation"], undefined);
    }
  });

  it("preserves CRLF and never edits body lines", () => {
    const content = "---\r\nname: my-skill\r\ndisable-model-invocation: false\r\n---\r\nUse disable-model-invocation: true.\r\n";
    const updated = setDisableModelInvocation(content, true);
    assert.match(updated, /disable-model-invocation: true\r\n/);
    assert.match(updated, /Use disable-model-invocation: true/);
  });

  it("rejects unsupported key formatting and is a no-op when absent and disabled", () => {
    assert.throws(() => setDisableModelInvocation("---\n{ disable-model-invocation: false }\n---\n", true), /unsupported frontmatter formatting/);
    assert.equal(setDisableModelInvocation(withFrontmatter, false), withFrontmatter);
  });
});
