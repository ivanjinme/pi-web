const STORAGE_KEY = "pi-web:project-folders";

export function loadProjectFolders(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const value = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "[]") as unknown;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export function saveProjectFolders(folders: string[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(folders));
  } catch {
    // Storage is optional; session cwd remains authoritative.
  }
}

export function rememberProjectFolder(cwd: string): void {
  const folders = loadProjectFolders();
  if (!folders.includes(cwd)) saveProjectFolders([...folders, cwd]);
}
