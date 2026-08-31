// In-memory roots that should be browsable in addition to roots derived from
// persisted sessions. Stored on globalThis so Next.js hot-reload keeps them.
declare global {
  var __piAllowedRootsCache: { roots: Set<string>; expiresAt: number } | undefined;
  var __piAdditionalAllowedRoots: Set<string> | undefined;
}

export function normalizeSlashes(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

export function getAdditionalAllowedRoots(): Set<string> {
  if (!globalThis.__piAdditionalAllowedRoots) {
    globalThis.__piAdditionalAllowedRoots = new Set();
  }
  return globalThis.__piAdditionalAllowedRoots;
}

export function allowFileRoot(root: string): void {
  if (!root) return;
  const normalizedRoot = normalizeSlashes(root);
  getAdditionalAllowedRoots().add(normalizedRoot);
  globalThis.__piAllowedRootsCache?.roots.add(normalizedRoot);
}

/** Replace an explicitly-authorized project root after its source folder changes. */
export function replaceAllowedFileRoot(oldRoot: string, newRoot: string): void {
  const comparable = (value: string) => {
    const normalized = normalizeSlashes(value);
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  };
  const oldKey = comparable(oldRoot);
  const additionalRoots = getAdditionalAllowedRoots();
  for (const root of additionalRoots) {
    if (comparable(root) === oldKey) additionalRoots.delete(root);
  }
  additionalRoots.add(normalizeSlashes(newRoot));
  // Force the next request to rebuild roots from the migrated session headers.
  globalThis.__piAllowedRootsCache = undefined;
}
