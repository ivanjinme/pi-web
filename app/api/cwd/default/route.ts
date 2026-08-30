import { mkdirSync } from "fs";
import { NextResponse } from "next/server";
import { getDefaultWorkspacePath } from "@/lib/default-workspace";
import { allowFileRoot } from "@/lib/file-access";

// Creates one deterministic fallback workspace. This intentionally performs no
// home-directory enumeration: output tracing must never discover user files.
export async function POST() {
  try {
    const cwd = getDefaultWorkspacePath();
    mkdirSync(cwd, { recursive: true });
    allowFileRoot(cwd);
    return NextResponse.json({ cwd });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
