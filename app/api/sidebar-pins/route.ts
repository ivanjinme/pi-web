import { NextResponse } from "next/server";
import { readSidebarPins, setSidebarPin } from "@/lib/sidebar-pins";

export async function GET() {
  try {
    return NextResponse.json({ pins: readSidebarPins() });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  try {
    const { type, id, pinned } = await request.json() as { type?: unknown; id?: unknown; pinned?: unknown };
    if ((type !== "project" && type !== "session") || typeof id !== "string" || !id.trim() || typeof pinned !== "boolean") {
      return NextResponse.json({ error: "type, id and pinned are required" }, { status: 400 });
    }
    return NextResponse.json({ pins: setSidebarPin({ type, id }, pinned) });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
