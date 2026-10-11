export const FILE_SAVE_DEBOUNCE_MS = 800;
export const FILE_SAVE_MAX_WAIT_MS = 5000;
export type FileSaveStatus = "saved" | "dirty" | "saving" | "failed";
export interface DraftSnapshot {
  path: string;
  text: string;
  confirmed: string;
  revision: number;
  status: FileSaveStatus;
  error: string | null;
  editable: boolean;
  language: string;
  // null 表示尚未成功读取；只读预览保留服务端的原始字节数。
  size: number | null;
}
interface Entry {
  snapshot: DraftSnapshot;
  inFlight: boolean;
  uncertain: boolean;
  composing: boolean;
  pendingExternal: boolean;
  debounce?: ReturnType<typeof setTimeout>;
  maxWait?: ReturnType<typeof setTimeout>;
  readGeneration: number;
  readsInFlight: number;
  users: number;
}
export interface FileReadResult {
  content: string;
  language: string;
  size: number;
  editable: boolean;
}
export function draftPathKey(path: string): string {
  const slash = path.replace(/\\/g, "/");
  const parts: string[] = [];
  let rootSegments = 0;
  if (/^[a-z]:\//i.test(slash)) rootSegments = 1;
  else if (slash.startsWith("//")) rootSegments = 2;
  const absolute = rootSegments > 0 || slash.startsWith("/");
  for (const part of slash.split("/")) {
    if (part === "..") {
      if (parts.length > rootSegments && parts.at(-1) !== "..") parts.pop();
      else if (!absolute) parts.push(part);
    } else if (part && part !== ".") parts.push(part);
  }
  let prefix = "";
  if (slash.startsWith("//")) prefix = "//";
  else if (slash.startsWith("/")) prefix = "/";
  const normalized = prefix + parts.join("/");
  return /^[a-z]:\//i.test(normalized) || slash.startsWith("//") ? normalized.toLowerCase() : normalized;
}

export class FileDraftCoordinator {
  private entries = new Map<string, Entry>();
  private listeners = new Set<() => void>();
  private problems: readonly DraftSnapshot[] = [];
  constructor(private save: (path: string, text: string) => Promise<void>,
    private read: (path: string, sessionId?: string | null) => Promise<FileReadResult>,
    private settled: (path: string) => void = () => {}) {}
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  getProblems = (): readonly DraftSnapshot[] => this.problems;
  get(path: string): DraftSnapshot | null {
    return this.entries.get(draftPathKey(path))?.snapshot ?? null;
  }
  private entry(path: string): Entry {
    const key = draftPathKey(path);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { snapshot: { path, text: "", confirmed: "", revision: 0, status: "saved", error: null, editable: false, language: "text", size: null },
        inFlight: false, uncertain: false, composing: false, pendingExternal: false, readGeneration: 0, readsInFlight: 0, users: 0 };
      this.entries.set(key, entry);
    }
    return entry;
  }
  private notify(): void {
    this.problems = [...this.entries.values()]
      .map((entry) => entry.snapshot)
      .filter((snapshot) => snapshot.status !== "saved");
    for (const listener of this.listeners) listener();
    // 仅释放无人使用且已稳定保存的旧条目；失败/在途草稿永不淘汰。
    for (const [key, entry] of this.entries) {
      if (this.entries.size <= 20) break;
      if (!entry.users && entry.snapshot.status === "saved" && !entry.readsInFlight) this.entries.delete(key);
    }
  }
  retain(path: string): void { this.entry(path).users++; }
  release(path: string): void {
    const entry = this.entry(path);
    entry.users = Math.max(0, entry.users - 1);
    void this.flush(path);
  }
  private clearTimers(entry: Entry): void {
    clearTimeout(entry.debounce);
    clearTimeout(entry.maxWait);
    entry.debounce = undefined;
    entry.maxWait = undefined;
  }
  private scheduleSave(path: string, entry: Entry): void {
    clearTimeout(entry.debounce);
    entry.debounce = setTimeout(() => {
      entry.debounce = undefined;
      void this.flush(path);
    }, FILE_SAVE_DEBOUNCE_MS);
    entry.maxWait ??= setTimeout(() => {
      entry.maxWait = undefined;
      void this.flush(path);
    }, FILE_SAVE_MAX_WAIT_MS);
  }
  edit(path: string, text: string): void {
    const entry = this.entry(path);
    const old = entry.snapshot;
    if (!old.editable || text === old.text) return;
    let status: FileSaveStatus = "dirty";
    if (entry.inFlight) status = "saving";
    else if (text === old.confirmed && !entry.uncertain) status = "saved";
    entry.snapshot = { ...old, text, revision: old.revision + 1, status, error: null };
    if (status === "saved") {
      this.clearTimers(entry);
      if (entry.pendingExternal) void this.reconcile(path);
    } else {
      this.scheduleSave(path, entry);
    }
    this.notify();
  }
  composition(path: string, active: boolean): void {
    const entry = this.entry(path);
    entry.composing = active;
    if (active) return;
    if (entry.snapshot.status === "saved") {
      if (entry.pendingExternal) void this.reconcile(path);
    } else {
      this.scheduleSave(path, entry);
    }
  }
  async flush(path: string): Promise<void> {
    const entry = this.entry(path);
    if (entry.composing || entry.inFlight || !entry.snapshot.editable) return;
    this.clearTimers(entry);
    if (entry.snapshot.text === entry.snapshot.confirmed && !entry.uncertain) {
      entry.snapshot = { ...entry.snapshot, status: "saved", error: null };
      this.notify();
      return;
    }
    const submitted = entry.snapshot;
    entry.inFlight = true;
    // 失败响应不证明未落盘；撤销回 confirmed 也可能仍需写回。
    entry.uncertain = true;
    entry.snapshot = { ...entry.snapshot, status: "saving", error: null };
    this.notify();
    try {
      await this.save(submitted.path, submitted.text);
    } catch (error) {
      entry.inFlight = false;
      this.clearTimers(entry);
      entry.snapshot = { ...entry.snapshot, status: "failed", error: error instanceof Error ? error.message : String(error) };
      this.notify();
      return;
    }
    entry.inFlight = false;
    entry.uncertain = false;
    entry.snapshot = { ...entry.snapshot, confirmed: submitted.text,
      status: entry.snapshot.text === submitted.text ? "saved" : "dirty", error: null };
    this.notify();
    if (entry.snapshot.status === "dirty") {
      await this.flush(path);
      return;
    }
    this.settled(submitted.path);
    if (entry.pendingExternal) void this.reconcile(path);
  }
  private async reconcile(path: string): Promise<void> {
    try {
      await this.refresh(path);
    } catch (error) {
      const entry = this.entry(path);
      entry.snapshot = { ...entry.snapshot, error: `Saved, but refresh failed: ${error instanceof Error ? error.message : String(error)}` };
      this.notify();
    }
  }
  async refresh(path: string, sessionId?: string | null): Promise<FileReadResult | null> {
    const entry = this.entry(path);
    if (entry.snapshot.status !== "saved" || entry.inFlight || entry.composing) {
      entry.pendingExternal = true;
      return null;
    }
    const revision = entry.snapshot.revision;
    const generation = ++entry.readGeneration;
    entry.readsInFlight++;
    let result: FileReadResult;
    try {
      result = await this.read(path, sessionId);
    } finally {
      entry.readsInFlight--;
    }
    if (generation !== entry.readGeneration) return null;
    if (revision !== entry.snapshot.revision || entry.snapshot.status !== "saved" || entry.inFlight || entry.composing) {
      entry.pendingExternal = true;
      if (entry.snapshot.status === "saved" && !entry.inFlight && !entry.composing) void this.reconcile(path);
      return null;
    }
    entry.pendingExternal = false;
    entry.snapshot = { ...entry.snapshot, text: result.content, confirmed: result.content, size: result.size, editable: result.editable, language: result.language, error: null };
    this.notify();
    return result;
  }
}
