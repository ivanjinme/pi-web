const STORAGE_KEY = "pi-web:project-folders";
const HIDDEN_STORAGE_KEY = "pi-web:hidden-project-folders";
export const PROJECT_FOLDERS_CHANGED_EVENT = "pi-web:project-folders-changed";

function loadStringArray(key: string): string[] {
  if (typeof window === "undefined") return [];
  try {
    const value = JSON.parse(window.localStorage.getItem(key) ?? "[]") as unknown;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function saveStringArray(key: string, values: string[]): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(values));
  } catch {
    // Storage is optional; session cwd remains authoritative.
  }
}

export function projectPathKey(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[a-zA-Z]:\//.test(normalized) || normalized.startsWith("//")
    ? normalized.toLowerCase()
    : normalized;
}

function notifyChanged(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(PROJECT_FOLDERS_CHANGED_EVENT));
}

export function loadProjectFolders(): string[] {
  return loadStringArray(STORAGE_KEY);
}

export function loadHiddenProjectFolders(): string[] {
  return loadStringArray(HIDDEN_STORAGE_KEY);
}

export function isProjectFolderHidden(root: string, hidden = loadHiddenProjectFolders()): boolean {
  const key = projectPathKey(root);
  return hidden.some((item) => projectPathKey(item) === key);
}

function hideProjectFolder(root: string): void {
  const hidden = loadHiddenProjectFolders();
  if (!isProjectFolderHidden(root, hidden)) saveStringArray(HIDDEN_STORAGE_KEY, [...hidden, root]);
  notifyChanged();
}

function unhideProjectFolder(root: string): void {
  const key = projectPathKey(root);
  const hidden = loadHiddenProjectFolders();
  const next = hidden.filter((item) => projectPathKey(item) !== key);
  if (next.length !== hidden.length) saveStringArray(HIDDEN_STORAGE_KEY, next);
  notifyChanged();
}

export function rememberProjectFolder(cwd: string): string[] {
  const folders = loadProjectFolders();
  const next = folders.some((folder) => projectPathKey(folder) === projectPathKey(cwd))
    ? folders
    : [...folders, cwd];
  saveStringArray(STORAGE_KEY, next);
  unhideProjectFolder(cwd);
  return next;
}

export function replaceProjectFolder(previousRoot: string, nextRoot: string): string[] {
  const folders = loadProjectFolders().filter((path) => path !== previousRoot);
  const next = folders.includes(nextRoot) ? folders : [...folders, nextRoot];
  saveStringArray(STORAGE_KEY, next);
  unhideProjectFolder(nextRoot);
  return next;
}

export function forgetProjectFolder(root: string): string[] {
  const next = loadProjectFolders().filter((path) => path !== root);
  saveStringArray(STORAGE_KEY, next);
  hideProjectFolder(root);
  return next;
}
