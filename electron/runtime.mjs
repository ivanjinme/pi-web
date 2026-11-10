import { win32 } from "node:path";

export function createRuntimeEnvironment(runtimeRoot, env = process.env, platform = process.platform) {
  const result = { ...env };
  if (platform !== "win32") return result;

  const entries = [];
  for (const key of Object.keys(result)) {
    if (key.toLowerCase() !== "path") continue;
    entries.push(...result[key].split(";"));
    delete result[key];
  }
  // 保留原有查找顺序，包内工具只兜底；Windows 环境中只保留一个 PATH 键。
  entries.push(win32.join(runtimeRoot, "tools"));
  const seen = new Set();
  result.PATH = entries.filter((entry) => {
    if (!entry || seen.has(entry.toLowerCase())) return false;
    seen.add(entry.toLowerCase());
    return true;
  }).join(";");
  return result;
}
