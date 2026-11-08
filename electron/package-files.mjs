import { cp, stat } from "node:fs/promises";

// 仅排除明确的源码映射后缀，保留其他 .map 资源。
export function shouldCopyDependencyFile(sourcePath) {
  return !/\.(?:js|cjs|mjs|jsx|ts|cts|mts|tsx|css)\.map$/.test(sourcePath);
}

export async function copyProductionDependency(source, destination) {
  await cp(source, destination, {
    recursive: true,
    dereference: true,
    filter: async (sourcePath) => shouldCopyDependencyFile(sourcePath) || (await stat(sourcePath)).isDirectory(),
  });
}
