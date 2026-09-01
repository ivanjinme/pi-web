export interface ToolEntry {
  name: string;
  description: string;
  active: boolean;
  source: string;
}

export type ToolPreset = "none" | "default" | "full";

export interface ShellAvailability {
  bash: boolean;
  powershell: boolean;
}

const SHELL_TOOL_NAMES = new Set(["bash", "powershell"]);

export function isToolPreset(value: unknown): value is ToolPreset {
  return value === "none" || value === "default" || value === "full";
}

export function getPresetFromTools(tools: ToolEntry[]): ToolPreset {
  const activeTools = tools.filter((tool) => tool.active);
  if (activeTools.length === 0) return "none";

  const activeNames = new Set(activeTools.map((tool) => tool.name));
  const nonShellBuiltinNames = tools
    .filter((tool) => tool.source === "builtin" && !SHELL_TOOL_NAMES.has(tool.name))
    .map((tool) => tool.name);
  const hasActiveBuiltin = activeTools.some((tool) => tool.source === "builtin");

  return hasActiveBuiltin && nonShellBuiltinNames.every((name) => activeNames.has(name)) ? "full" : "default";
}

export function getToolNamesForPreset(
  preset: ToolPreset,
  shells: ShellAvailability,
  builtinToolNames: string[],
): string[] {
  if (preset === "none") return [];

  if (preset === "default") {
    const preferredShell = shells.bash ? "bash" : shells.powershell ? "powershell" : undefined;
    return ["read", ...(preferredShell ? [preferredShell] : []), "edit", "write"];
  }

  return builtinToolNames.filter((name) => {
    if (name === "bash") return shells.bash;
    if (name === "powershell") return shells.powershell;
    return true;
  });
}
