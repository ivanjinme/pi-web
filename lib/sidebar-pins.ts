import { mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { projectPathKey } from "./project-folders";

export interface SidebarPin {
  type: "project" | "session";
  id: string;
}

interface SidebarData {
  version: 1;
  pins: SidebarPin[];
}

const SIDEBAR_FILE = join(homedir(), ".weclio", "sidebar.json");

export function readSidebarPins(file = SIDEBAR_FILE): SidebarPin[] {
  try {
    const data = JSON.parse(readFileSync(file, "utf8")) as SidebarData;
    return data.pins;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function samePin(a: SidebarPin, b: SidebarPin): boolean {
  return a.type === b.type && (a.type === "project"
    ? projectPathKey(a.id) === projectPathKey(b.id)
    : a.id === b.id);
}

function updateSidebarPins(update: (pins: SidebarPin[]) => SidebarPin[], file: string): SidebarPin[] {
  // 同步读改写不跨 await，避免同一服务进程内的并发请求互相覆盖。
  const previous = readSidebarPins(file);
  const pins = update(previous);
  if (pins === previous) return pins;
  mkdirSync(dirname(file), { recursive: true });
  const temporaryFile = `${file}.tmp`;
  writeFileSync(temporaryFile, JSON.stringify({ version: 1, pins } satisfies SidebarData, null, 2) + "\n", "utf8");
  renameSync(temporaryFile, file);
  return pins;
}

export function setSidebarPin(pin: SidebarPin, pinned: boolean, file = SIDEBAR_FILE): SidebarPin[] {
  return updateSidebarPins((pins) => {
    if (pins.some((item) => samePin(item, pin)) === pinned) return pins;
    return pinned ? [...pins, pin] : pins.filter((item) => !samePin(item, pin));
  }, file);
}

export function rebindPinnedProject(oldRoot: string, newRoot: string, file = SIDEBAR_FILE): void {
  const previous: SidebarPin = { type: "project", id: oldRoot };
  updateSidebarPins((pins) => {
    if (!pins.some((pin) => samePin(pin, previous))) return pins;
    const next = pins.map((pin) => samePin(pin, previous) ? { ...pin, id: newRoot } : pin);
    return next.filter((pin, index) => next.findIndex((item) => samePin(item, pin)) === index);
  }, file);
}
