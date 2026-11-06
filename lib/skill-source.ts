import type { SkillInfo } from "@/lib/api-types";

interface SkillSource {
  label: string;
  href?: string;
}

export function getSkillSource(skill: Pick<SkillInfo, "install" | "sourceInfo">): SkillSource {
  const source = (skill.install?.source ?? skill.sourceInfo?.source ?? "").trim();
  const sourceType = skill.install?.sourceType;
  if (!source || sourceType === "local") return { label: "Local" };

  if (source.startsWith("npm:") || sourceType === "npm") {
    return { label: `npm · ${source.replace(/^npm:/, "")}` };
  }

  let repository = source.replace(/^git\+/, "").replace(/^git:(?!\/\/)/, "");
  if (sourceType === "github" && /^[\w.-]+\/[\w.-]+$/.test(repository)) {
    repository = `https://github.com/${repository}`;
  }
  // SSH 只用于展示仓库位置，不猜测对应的网页地址。
  const ssh = repository.match(/^([^/@:]+@[^/:]+):(.+)$/);
  if (ssh) repository = `ssh://${ssh[1]}/${ssh[2]}`;
  if (source.startsWith("git:") && !repository.includes("://") && /^[\w.-]+\.[\w.-]+\//.test(repository)) {
    repository = `https://${repository}`;
  }

  let url: URL;
  try {
    url = new URL(repository);
  } catch {
    return { label: "Local" };
  }
  if (!["https:", "http:", "ssh:", "git:"].includes(url.protocol)) {
    return { label: "Local" };
  }

  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/@.*$/, "").replace(/\/$/, "").replace(/\.git$/, "");
  const label = `Git · ${url.host}${url.pathname}`;
  return url.protocol === "https:" || url.protocol === "http:"
    ? { label, href: url.toString() }
    : { label };
}
