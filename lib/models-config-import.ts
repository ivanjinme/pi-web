interface ModelWithBaseUrl {
  baseUrl?: string;
}

interface ProviderWithModels {
  baseUrl?: string;
  models?: ModelWithBaseUrl[];
}

export function normalizeOptionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

export function findProviderMissingModelBaseUrl(
  providers: Record<string, ProviderWithModels> | undefined,
): string | undefined {
  for (const [providerId, provider] of Object.entries(providers ?? {})) {
    if (normalizeOptionalString(provider.baseUrl) || !provider.models?.length) continue;
    if (provider.models.some((model) => !normalizeOptionalString(model.baseUrl))) return providerId;
  }
  return undefined;
}
