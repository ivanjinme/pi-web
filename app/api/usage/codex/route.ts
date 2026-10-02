import { getCodexUsage } from "@/lib/codex-usage";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  return Response.json(await getCodexUsage(), {
    headers: { "Cache-Control": "no-store" },
  });
}
