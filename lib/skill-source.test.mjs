import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { getSkillSource } = await jiti.import("./skill-source.ts");

function skill(source, sourceType) {
  return sourceType
    ? { install: { source, sourceType }, sourceInfo: { source: "local" } }
    : { sourceInfo: { source } };
}

test("prefers the recorded upstream over the loader's local source", () => {
  assert.deepEqual(getSkillSource(skill("mattpocock/skills", "github")), {
    label: "Git · github.com/mattpocock/skills",
    href: "https://github.com/mattpocock/skills",
  });
});

test("uses the same Git display for GitHub and other Git hosts", () => {
  for (const source of [
    "git:github.com/owner/repo@main",
    "https://github.com/owner/repo.git",
    "git+https://github.com/owner/repo.git#main",
  ]) {
    assert.deepEqual(getSkillSource(skill(source)), {
      label: "Git · github.com/owner/repo",
      href: "https://github.com/owner/repo",
    });
  }
  assert.deepEqual(getSkillSource(skill("https://git.example.com/team/skills.git", "git")), {
    label: "Git · git.example.com/team/skills",
    href: "https://git.example.com/team/skills",
  });
});

test("shows SSH repositories without inventing a web link", () => {
  for (const source of [
    "git:git@git.example.com:team/skills.git@main",
    "ssh://git@git.example.com/team/skills.git",
  ]) {
    assert.deepEqual(getSkillSource(skill(source)), {
      label: "Git · git.example.com/team/skills",
    });
  }
});

test("does not expose credentials or query parameters in Git sources", () => {
  assert.deepEqual(getSkillSource(skill("https://user:secret@git.example.com/team/skills.git?token=secret#main")), {
    label: "Git · git.example.com/team/skills",
    href: "https://git.example.com/team/skills",
  });
});

test("shows npm sources without assuming a public registry", () => {
  assert.deepEqual(getSkillSource(skill("npm:@company/skills@1.2.3")), {
    label: "npm · @company/skills@1.2.3",
  });
  assert.deepEqual(getSkillSource(skill("weclio-cli", "npm")), {
    label: "npm · weclio-cli",
  });
});

test("falls back to Local without treating local paths or unsupported URLs as Git", () => {
  for (const source of [undefined, "", "local", "user", "project", "cli", "./skills", "C:\\skills", "https://", "javascript:alert(1)"]) {
    assert.deepEqual(getSkillSource(skill(source)), { label: "Local" });
  }
  assert.deepEqual(getSkillSource(skill("https://example.com/local", "local")), { label: "Local" });
  assert.deepEqual(getSkillSource(skill("owner/repo")), { label: "Local" });
});
