import { join } from "path";
import { NextResponse } from "next/server";
import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { normalizeOptionalString } from "@/lib/models-config-import";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ provider: string }> };

export async function GET(_req: Request, { params }: Params) {
  const { provider: providerId } = await params;
  const agentDir = getAgentDir();
  const runtime = await ModelRuntime.create({
    modelsPath: join(agentDir, ".models-defaults.json"),
    modelsStorePath: join(agentDir, "models-store.json"),
    refreshOnCreate: false,
  });
  const refreshResult = await runtime.refresh({ providers: [providerId], allowNetwork: true, force: true });
  const refreshError = refreshResult.errors.get(providerId);
  if (refreshError) {
    return NextResponse.json(
      { error: `Failed to refresh provider ${providerId}: ${refreshError.message}` },
      { status: 502 },
    );
  }

  const provider = runtime.getProvider(providerId);
  const models = runtime.getModels(providerId);

  if (!provider || models.length === 0) {
    return NextResponse.json({ error: `Provider not found: ${providerId}` }, { status: 404 });
  }

  const api = models[0].api;
  const baseUrl = normalizeOptionalString(provider.baseUrl ?? models[0].baseUrl);

  return NextResponse.json({
    provider: {
      api,
      baseUrl,
      models: models.map((model) => {
        const modelBaseUrl = normalizeOptionalString(model.baseUrl);
        return {
          id: model.id,
          name: model.name,
          api: model.api === api ? undefined : model.api,
          baseUrl: modelBaseUrl === baseUrl ? undefined : modelBaseUrl,
          reasoning: model.reasoning,
          thinkingLevelMap: model.thinkingLevelMap,
          input: model.input,
          contextWindow: model.contextWindow,
          maxTokens: model.maxTokens,
          cost: model.cost,
          samplingParams: model.samplingParams,
          headers: model.headers,
          compat: model.compat,
        };
      }),
    },
  });
}
