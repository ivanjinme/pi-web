import { closeSync, createReadStream, openSync, readSync } from "fs";
import { open, readdir, stat } from "fs/promises";
import type { FileHandle } from "fs/promises";
import { join } from "path";
import { createInterface } from "readline";
import type { SessionHeader } from "./types";

const MAX_HEADER_BYTES = 64 * 1024;
const BLOCK_SIZE = 1024 * 1024;
const TITLE_TOKEN = Buffer.from('"session_info"');

export interface SessionTitle {
  name?: string;
  firstMessage: string;
}

export interface SessionFile {
  path: string;
  header: SessionHeader;
  modified: string;
}

async function mapLimited<T, R>(items: T[], limit: number, load: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await load(items[index]);
    }
  }));
  return results;
}

export function readSessionHeader(filePath: string): SessionHeader | null {
  const fd = openSync(filePath, "r");
  try {
    const chunks: Buffer[] = [];
    let position = 0;
    let foundNewline = false;
    while (position < MAX_HEADER_BYTES) {
      const buffer = Buffer.allocUnsafe(Math.min(4096, MAX_HEADER_BYTES - position));
      const bytesRead = readSync(fd, buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      const data = buffer.subarray(0, bytesRead);
      const newline = data.indexOf(10);
      chunks.push(newline < 0 ? data : data.subarray(0, newline));
      position += bytesRead;
      if (newline >= 0) {
        foundNewline = true;
        break;
      }
    }
    if (!foundNewline && position >= MAX_HEADER_BYTES) return null;
    try {
      const header = JSON.parse(Buffer.concat(chunks).toString("utf8")) as SessionHeader;
      return header?.type === "session" ? header : null;
    } catch (error) {
      if (error instanceof SyntaxError) return null;
      throw error;
    }
  } finally {
    closeSync(fd);
  }
}

function isMissing(error: unknown): boolean {
  return ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "");
}

export async function discoverSessionFiles(root: string): Promise<SessionFile[]> {
  let directories;
  try {
    directories = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const files = (await mapLimited(directories.filter((entry) => entry.isDirectory() || entry.isSymbolicLink()), 32, async (entry) => {
    const dir = join(root, entry.name);
    try {
      return (await readdir(dir)).filter((name) => name.endsWith(".jsonl")).map((name) => join(dir, name));
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
  })).flat();
  const sessions = await mapLimited(files, 32, async (path): Promise<SessionFile | null> => {
    try {
      const header = readSessionHeader(path);
      if (!header) return null;
      const stats = await stat(path);
      return { path, header, modified: stats.mtime.toISOString() };
    } catch (error) {
      // 枚举后会话可能被删除；其他 I/O 错误交给调用方处理。
      if (isMissing(error)) return null;
      throw error;
    }
  });
  return sessions.filter((session): session is SessionFile => session !== null)
    .sort((a, b) => b.modified.localeCompare(a.modified));
}

async function readBlock(file: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(length);
  const { bytesRead } = await file.read(buffer, 0, length, position);
  return buffer.subarray(0, bytesRead);
}

async function readRecordAt(file: FileHandle, position: number, size: number): Promise<string> {
  const before: Buffer[] = [];
  let start = position;
  while (start > 0) {
    const from = Math.max(0, start - 4096);
    const chunk = await readBlock(file, from, start - from);
    const newline = chunk.lastIndexOf(10);
    before.push(chunk.subarray(newline + 1));
    start = from;
    if (newline >= 0) break;
  }
  const after: Buffer[] = [];
  let end = position;
  while (end < size) {
    const chunk = await readBlock(file, end, Math.min(4096, size - end));
    if (!chunk.length) break;
    const newline = chunk.indexOf(10);
    after.push(newline < 0 ? chunk : chunk.subarray(0, newline));
    end += chunk.length;
    if (newline >= 0) break;
  }
  return Buffer.concat([...before.reverse(), ...after]).toString("utf8");
}

function parseRecord(line: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch (error) {
    // 与 SDK 一致，忽略尚未写完或格式损坏的行。
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

export async function readSessionTitle(path: string): Promise<SessionTitle> {
  const file = await open(path, "r");
  try {
    const { size } = await file.stat();
    let end = size;
    let overlap: Buffer = Buffer.alloc(0);
    // 复用缓冲区，减少大文件扫描时的分配、复制和异步读取次数。
    const buffer = Buffer.allocUnsafe(BLOCK_SIZE + TITLE_TOKEN.length - 1);
    search: while (end > 0) {
      const start = Math.max(0, end - BLOCK_SIZE);
      const { bytesRead } = await file.read(buffer, 0, end - start, start);
      overlap.copy(buffer, bytesRead);
      const searchable = buffer.subarray(0, bytesRead + overlap.length);
      let index = searchable.lastIndexOf(TITLE_TOKEN, bytesRead - 1);
      while (index >= 0) {
        const entry = parseRecord(await readRecordAt(file, start + index, size));
        if (entry?.type === "session_info") {
          const name = typeof entry.name === "string" ? entry.name.trim() : "";
          if (name) return { name, firstMessage: "" };
          // 最新空名称是显式清除，不应复活更早的标题。
          break search;
        }
        index = index === 0 ? -1 : searchable.lastIndexOf(TITLE_TOKEN, index - 1);
      }
      overlap = Buffer.from(searchable.subarray(0, TITLE_TOKEN.length - 1));
      end = start;
    }
  } finally {
    await file.close();
  }

  return { firstMessage: (await readSessionFirstMessage(path)).slice(0, 50) };
}

// 搜索只读取首条用户文本，不构建完整 transcript。
export async function readSessionFirstMessage(path: string): Promise<string> {
  const input = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!/"role"\s*:\s*"user"/.test(line)) continue;
      const entry = parseRecord(line);
      if (entry?.type !== "message") continue;
      const message = entry.message as { role?: string; content?: string | { type: string; text?: string }[] } | undefined;
      if (message?.role !== "user") continue;
      const content = message.content;
      const text = typeof content === "string" ? content
        : content?.filter((block) => block.type === "text").map((block) => block.text).join(" ");
      if (text) return text;
    }
    return "(no messages)";
  } finally {
    lines.close();
    input.destroy();
  }
}

export async function readSessionTitles(files: { id: string; path: string }[], includeFirstMessage = false): Promise<(SessionTitle & { id: string })[]> {
  const titles = await mapLimited(files, 10, async ({ id, path }) => {
    try {
      const title = await readSessionTitle(path);
      return { id, ...title, ...(includeFirstMessage ? { firstMessage: await readSessionFirstMessage(path) } : {}) };
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  });
  return titles.filter((title): title is SessionTitle & { id: string } => title !== null);
}
