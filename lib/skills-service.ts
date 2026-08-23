import { homedir } from "os";
import { DefaultResourceLoader, getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { SkillInfo, SkillsResponse } from "@/lib/api-types";
import { annotateSkillsWithInstallInfo } from "@/lib/skill-lock";
import { getProjectTrustStatus, projectTrustReloadOptions } from "@/lib/project-trust";

export async function loadSkillsWithInstallInfo(cwd?: string): Promise<SkillsResponse> {
  const agentDir = getAgentDir();
  const contextCwd = cwd ?? homedir();
  const projectTrusted = cwd ? getProjectTrustStatus(cwd, agentDir).trusted : false;
  const settingsManager = SettingsManager.create(contextCwd, agentDir, { projectTrusted });
  const loader = new DefaultResourceLoader({ cwd: contextCwd, agentDir, settingsManager });
  if (cwd) await loader.reload(projectTrustReloadOptions(cwd, agentDir));
  else await loader.reload();
  const { skills, diagnostics } = loader.getSkills();
  return {
    skills: annotateSkillsWithInstallInfo(skills as SkillInfo[], { cwd: contextCwd, agentDir }),
    diagnostics,
    projectResourcesLoaded: projectTrusted,
  };
}
