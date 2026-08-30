import { NextResponse } from "next/server";
import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { invalidateModelsCache } from "@/lib/models-cache";
import { getDefaultWorkspacePath } from "@/lib/default-workspace";

export const dynamic = "force-dynamic";

// Remember the last user-selected model as the global default in
// ~/.pi/agent/settings.json, so new sessions (any browser) start on it.
export async function PUT(req: Request) {
  try {
    const { provider, modelId } = (await req.json()) as { provider?: unknown; modelId?: unknown };
    if (typeof provider !== "string" || typeof modelId !== "string") {
      return NextResponse.json({ error: "provider and modelId are required" }, { status: 400 });
    }
    const settingsManager = SettingsManager.create(getDefaultWorkspacePath(), getAgentDir(), { projectTrusted: false });
    settingsManager.setDefaultModelAndProvider(provider, modelId);
    await settingsManager.flush();
    invalidateModelsCache();
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
