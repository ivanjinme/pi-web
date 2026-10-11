import fs from "node:fs";
import { isPathWithinRoots } from "./path-security";
import { getAudioMime, getDocumentMime, getImageMime, TEXT_PREVIEW_MAX_BYTES } from "./file-types";

export class FileWriteError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

function assertEditableFileType(filePath: string): void {
  if (getImageMime(filePath) || getAudioMime(filePath) || getDocumentMime(filePath)) {
    throw new FileWriteError(415, "This file type is read-only");
  }
}

export function decodeEditableText(bytes: Uint8Array, filePath: string): string {
  assertEditableFileType(filePath);
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new FileWriteError(415, "File is not valid UTF-8 text"); }
  if (/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/.test(text)) {
    throw new FileWriteError(415, "Binary files cannot be edited as text");
  }
  return text;
}

export async function readTextBody(request: Request): Promise<Uint8Array> {
  if (!/^text\/plain(?:\s*;\s*charset=utf-8)?\s*$/i.test(request.headers.get("content-type") ?? "")) {
    throw new FileWriteError(415, "Expected text/plain; charset=utf-8");
  }
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > TEXT_PREVIEW_MAX_BYTES) {
        await reader.cancel();
        throw new FileWriteError(413, "Text exceeds 256 KiB");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

function resolvedTarget(filePath: string, roots: Set<string>): string {
  if (filePath.includes("\0")) throw new FileWriteError(400, "Invalid file path");
  if (!isPathWithinRoots(filePath, roots)) throw new FileWriteError(403, "Access denied");
  const target = fs.realpathSync(filePath);
  const realRoots = new Set<string>();
  for (const root of roots) {
    try { realRoots.add(fs.realpathSync(root)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (!isPathWithinRoots(target, realRoots)) throw new FileWriteError(403, "Access denied");
  if (!fs.statSync(target).isFile()) throw new FileWriteError(400, "Not a regular file");
  return target;
}

function inspectDescriptor(fd: number, filePath: string, target: string): fs.Stats {
  const stat = fs.fstatSync(fd);
  if (!stat.isFile()) throw new FileWriteError(400, "Not a regular file");
  if (stat.size > TEXT_PREVIEW_MAX_BYTES) throw new FileWriteError(413, "File exceeds 256 KiB");
  // 有界读取，不能因外部进程同时增长文件而读入无界内容。
  const bytes = Buffer.alloc(TEXT_PREVIEW_MAX_BYTES + 1);
  const size = fs.readSync(fd, bytes, 0, bytes.length, 0);
  if (size > TEXT_PREVIEW_MAX_BYTES) throw new FileWriteError(413, "File exceeds 256 KiB");
  decodeEditableText(bytes.subarray(0, size), filePath);
  if (target !== filePath) assertEditableFileType(target);
  return stat;
}

export function isEditableFile(filePath: string, roots: Set<string>): boolean {
  let fd: number | undefined;
  try {
    const target = resolvedTarget(filePath, roots);
    fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    inspectDescriptor(fd, filePath, target);
    fs.accessSync(target, fs.constants.W_OK);
    return true;
  } catch { return false; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

export function writeExistingText(filePath: string, roots: Set<string>, bytes: Uint8Array): number {
  if (bytes.byteLength > TEXT_PREVIEW_MAX_BYTES) throw new FileWriteError(413, "Text exceeds 256 KiB");
  decodeEditableText(bytes, filePath);
  let fd: number | undefined;
  try {
    const target = resolvedTarget(filePath, roots);
    // 不带 O_CREAT/O_TRUNC：授权和内容检查完成之前绝不改文件。
    fd = fs.openSync(target, fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW ?? 0));
    const stat = inspectDescriptor(fd, filePath, target);
    const currentTarget = resolvedTarget(filePath, roots);
    const current = fs.statSync(currentTarget);
    if (currentTarget !== target || current.dev !== stat.dev || current.ino !== stat.ino) {
      throw new FileWriteError(403, "File target changed during authorization");
    }
    let offset = 0;
    while (offset < bytes.byteLength) {
      offset += fs.writeSync(fd, bytes, offset, bytes.byteLength - offset, offset);
    }
    fs.ftruncateSync(fd, bytes.byteLength);
    return bytes.byteLength;
  } catch (error) {
    if (error instanceof FileWriteError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new FileWriteError(404, "File no longer exists");
    if (code === "EACCES" || code === "EPERM" || code === "ELOOP") throw new FileWriteError(403, "File is not writable");
    if (code === "EISDIR") throw new FileWriteError(400, "Not a regular file");
    throw new FileWriteError(500, "Failed to write file");
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
