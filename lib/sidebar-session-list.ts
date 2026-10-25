import type { SessionInfo } from "./types";

export function sessionDisplayTitle(session: Pick<SessionInfo, "name" | "firstMessage">): string {
  return session.name || session.firstMessage.slice(0, 50);
}

export interface SidebarThreadNode {
  session: SessionInfo;
  children: SidebarThreadNode[];
}

export function visibleThreadRoots(
  group: { sessions: SessionInfo[]; roots: SidebarThreadNode[] },
  count: number,
  selectedSessionId: string | null,
): SidebarThreadNode[] {
  const visible = group.roots.slice(0, count);
  if (!selectedSessionId) return visible;
  const byId = new Map(group.sessions.map((session) => [session.id, session]));
  let rootId = selectedSessionId;
  const visited = new Set<string>();
  let parentId = byId.get(rootId)?.parentSessionId;
  while (parentId && byId.has(parentId) && !visited.has(parentId)) {
    visited.add(parentId);
    rootId = parentId;
    parentId = byId.get(parentId)?.parentSessionId;
  }
  const selected = group.roots.find((node) => node.session.id === rootId);
  if (selected && !visible.includes(selected)) visible[visible.length - 1] = selected;
  return visible;
}

export function threadTitleIds(roots: SidebarThreadNode[]): string[] {
  const ids = new Set<string>();
  const pending = [...roots];
  while (pending.length) {
    const node = pending.pop()!;
    if (ids.has(node.session.id)) continue;
    ids.add(node.session.id);
    pending.push(...node.children);
  }
  return [...ids];
}
