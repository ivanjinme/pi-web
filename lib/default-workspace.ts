import { homedir } from "os";
import path from "path";

export const DEFAULT_WORKSPACE_ENV = "PI_WEB_DEFAULT_CWD";

export function getDefaultWorkspacePath(
  configuredPath = process.env[DEFAULT_WORKSPACE_ENV],
  userHome = homedir(),
): string {
  const configured = configuredPath?.trim();
  if (!configured) return path.join(userHome, ".weclio", "default-workspace");
  return path.resolve(configured);
}
