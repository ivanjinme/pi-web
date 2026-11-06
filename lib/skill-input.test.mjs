import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { expandSkillParts } = await jiti.import("./skill-input.ts");
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");

async function skillFixture(t) {
  const baseDir = await mkdtemp(join(tmpdir(), "weclio-skill-input-"));
  t.after(() => rm(baseDir, { recursive: true, force: true }));
  const filePath = join(baseDir, "SKILL.md");
  await writeFile(filePath, "---\nname: design\ndescription: test\n---\n\n# Instructions\nUse this skill.\n");
  const skill = { name: "design", filePath, baseDir };
  const parts = [{ type: "text", text: "前文 " }, { type: "skill", name: "design" }, { type: "text", text: " 后文" }];
  return { skill, parts };
}

test("loads inline skill content at its original position with its resource directory", async (t) => {
  const { skill, parts } = await skillFixture(t);
  const expanded = expandSkillParts(parts, [skill]);
  assert.ok(expanded.startsWith(`前文 <skill name="design" location="${skill.filePath}">`));
  assert.ok(expanded.includes(`References are relative to ${skill.baseDir}.`));
  assert.ok(expanded.includes("# Instructions\nUse this skill."));
  assert.ok(expanded.endsWith("</skill> 后文"));
  assert.ok(!expanded.includes("description: test"));
});

test("unavailable skills become literal commands without blocking loaded skills", async (t) => {
  const { skill, parts } = await skillFixture(t);
  assert.equal(expandSkillParts(parts, []), "前文 /skill:design 后文");
  assert.equal(expandSkillParts([
    { type: "skill", name: "removed" },
    { type: "text", text: "\n" },
    ...parts,
  ], [skill]), `/skill:removed\n${expandSkillParts(parts, [skill])}`);
});

for (const type of ["prompt", "steer", "follow_up"]) {
  test(`${type} loads selected skill nodes before handing input to the SDK`, async (t) => {
    const { skill, parts } = await skillFixture(t);
    const received = [];
    const inner = {
      sessionId: `skill-${type}`,
      agent: { state: {} },
      sessionManager: { getSessionFile: () => undefined, getEntries: () => [] },
      resourceLoader: { getSkills: () => ({ skills: [skill] }) },
      isBashRunning: false,
      prompt: async (message, options) => { received.push({ message, options }); },
      steer: async (message) => { received.push({ message }); },
      followUp: async (message) => { received.push({ message }); },
      extensionRunner: { async emit() {} },
      dispose() {},
    };
    const wrapper = new AgentSessionWrapper(inner, { bash: true, powershell: false });
    t.after(() => wrapper.shutdown());
    await wrapper.send({ type, message: "前文 /skill:design 后文", parts, streamingBehavior: "followUp" });
    assert.equal(received.length, 1);
    assert.equal(received[0].message, expandSkillParts(parts, [skill]));
    if (type === "prompt") assert.equal(received[0].options.streamingBehavior, "followUp");
    await wrapper.send({ type, message: "plain text" });
    assert.equal(received[1].message, "plain text");
    await wrapper.send({
      type,
      message: "前文 /skill:removed 后文",
      parts: [{ type: "text", text: "前文 " }, { type: "skill", name: "removed" }, { type: "text", text: " 后文" }],
    });
    assert.equal(received[2].message, "前文 /skill:removed 后文");
  });
}
