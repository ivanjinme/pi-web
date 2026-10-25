import { NextResponse } from "next/server";
import { listAllSessions, loadSessionTitles } from "@/lib/session-reader";
import { getRunningRpcSessionIds } from "@/lib/rpc-manager";

// POST 只接收目录中已有的 ID，不能由客户端指定文件路径。
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const ids = (body as { ids?: unknown } | null)?.ids;
  if (!Array.isArray(ids) || ids.length > 100 || !ids.every((id) => typeof id === "string")) {
    return NextResponse.json({ error: "ids must contain at most 100 session IDs" }, { status: 400 });
  }
  try {
    return NextResponse.json({ titles: await loadSessionTitles(ids) });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function GET() {
  try {
    const sessions = await listAllSessions();
    return NextResponse.json({ sessions, runningSessionIds: getRunningRpcSessionIds() });
  } catch (error) {
    return NextResponse.json(
      { error: String(error) },
      { status: 500 }
    );
  }
}
