import { NextRequest, NextResponse } from "next/server";
import { existsSync, readFileSync, statSync, writeFileSync } from "fs";
import { allowFileRoot, replaceAllowedFileRoot } from "@/lib/allowed-roots";
import { hasBusyRpcSessionForCwds, destroyRpcSessionsForCwds } from "@/lib/rpc-manager";
import { invalidateSessionListCache, listAllSessions } from "@/lib/session-reader";
import { sessionPathKey } from "@/lib/session-path";
import { invalidateProjectCache } from "@/lib/worktree";
import { isApiRequestAllowed } from "@/lib/request-security";

interface RebindRequest {
  oldRoot?: unknown;
  newRoot?: unknown;
}

function replaceSessionCwd(source: string, newRoot: string): string {
  const newlineIndex = source.indexOf("\n");
  const firstLineEnd = newlineIndex === -1 ? source.length : newlineIndex;
  const firstLine = source.slice(0, firstLineEnd).replace(/\r$/, "");
  const header = JSON.parse(firstLine) as { type?: string; cwd?: string };
  if (header.type !== "session") throw new Error("Invalid session header");
  header.cwd = newRoot;
  const lineEnding = source.slice(firstLine.length, firstLineEnd + 1);
  return JSON.stringify(header) + lineEnding + source.slice(firstLineEnd + 1);
}

export async function POST(request: NextRequest) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }

  try {
    const body = await request.json() as RebindRequest;
    const oldRoot = typeof body.oldRoot === "string" ? body.oldRoot.trim() : "";
    const newRoot = typeof body.newRoot === "string" ? body.newRoot.trim() : "";
    if (!oldRoot || !newRoot) {
      return NextResponse.json({ error: "oldRoot and newRoot are required" }, { status: 400 });
    }
    if (!existsSync(newRoot)) {
      return NextResponse.json({ error: `Directory does not exist: ${newRoot}` }, { status: 400 });
    }
    if (!statSync(newRoot).isDirectory()) {
      return NextResponse.json({ error: `Path is not a directory: ${newRoot}` }, { status: 400 });
    }

    const oldKey = sessionPathKey(oldRoot);
    const newKey = sessionPathKey(newRoot);
    if (oldKey === newKey) {
      allowFileRoot(newRoot);
      return NextResponse.json({ ok: true, migratedSessions: 0, cwd: newRoot });
    }

    const sessions = await listAllSessions();
    const matching = sessions.filter((session) =>
      session.cwd && sessionPathKey(session.projectRoot ?? session.cwd) === oldKey
    );
    const involvedCwds = new Map<string, string>([[oldKey, oldRoot]]);
    for (const session of matching) involvedCwds.set(sessionPathKey(session.cwd), session.cwd);

    if (hasBusyRpcSessionForCwds(involvedCwds.values())) {
      return NextResponse.json(
        { error: "A task is still running in this project. Stop it before changing the source folder." },
        { status: 409 },
      );
    }

    await destroyRpcSessionsForCwds(involvedCwds.values());

    // Prepare every rewrite before touching disk. If a later write fails, restore
    // the files already changed so one project cannot be split across two roots.
    const prepared = matching.map((session) => {
      const source = readFileSync(session.path, "utf8");
      return { path: session.path, source, updated: replaceSessionCwd(source, newRoot) };
    });
    const written: typeof prepared = [];
    try {
      for (const item of prepared) {
        writeFileSync(item.path, item.updated, "utf8");
        written.push(item);
      }
    } catch (error) {
      for (const item of written) {
        try { writeFileSync(item.path, item.source, "utf8"); } catch { /* best-effort rollback */ }
      }
      throw error;
    }

    replaceAllowedFileRoot(oldRoot, newRoot);
    invalidateSessionListCache();
    invalidateProjectCache();

    return NextResponse.json({ ok: true, migratedSessions: prepared.length, cwd: newRoot });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
