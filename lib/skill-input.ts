import { readFileSync } from "node:fs";
import { stripFrontmatter, type Skill } from "@earendil-works/pi-coding-agent";
import type { ComposerPart } from "./composer";

export function expandSkillParts(parts: ComposerPart[], skills: Pick<Skill, "name" | "filePath" | "baseDir">[]): string {
  return parts.map((part) => {
    if (part.type === "text") return part.text;
    const skill = skills.find((skill) => skill.name === part.name);
    if (!skill) return `/skill:${part.name}`;
    const body = stripFrontmatter(readFileSync(skill.filePath, "utf8")).trim();
    return `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
  }).join("");
}
