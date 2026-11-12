import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export function getExtensionPackageName(entryPath: string, packageRoot?: string): string | undefined {
  if (!packageRoot) return undefined;
  const root = resolve(packageRoot);
  const entry = resolve(entryPath);
  const rel = relative(root, entry);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;

  for (let dir = dirname(entry); ; dir = dirname(dir)) {
    const manifestPath = join(dir, "package.json");
    if (existsSync(manifestPath)) {
      let manifest: { name?: unknown; pi?: { extensions?: unknown } } | null;
      try {
        manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      } catch {
        // 名称元数据不可读时保留原有路径命名，不影响扩展列表。
        return undefined;
      }
      const entries = manifest?.pi?.extensions;
      // 只采用明确声明此单一入口的包名，避免把集合包名当作每个扩展名。
      if (
        typeof manifest?.name === "string" && manifest.name.trim() &&
        Array.isArray(entries) && entries.length === 1 &&
        typeof entries[0] === "string" && relative(resolve(dir, entries[0]), entry) === ""
      ) return manifest.name;
    }
    if (relative(root, dir) === "" || dirname(dir) === dir) return undefined;
  }
}
