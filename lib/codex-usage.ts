import { createHash } from "node:crypto";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AuthResult } from "@earendil-works/pi-ai";

export interface CodexUsageWindow {
  remainingPercent: number;
  resetAt: string | null;
}

export type CodexUsage =
  | { status: "available"; primary: CodexUsageWindow | null; secondary: CodexUsageWindow | null }
  | { status: "unavailable" };

const UNAVAILABLE: CodexUsage = { status: "unavailable" };
const CACHE_MS = 120_000;
const TIMEOUT_MS = 5_000;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function parseWindow(value: unknown): CodexUsageWindow | null {
  const window = record(value);
  const used = window?.used_percent;
  if (typeof used !== "number" || !Number.isFinite(used) || used < 0 || used > 100) return null;
  const reset = window?.reset_at;
  const date = typeof reset === "number" ? new Date(reset * 1000) : null;
  return {
    remainingPercent: 100 - used,
    resetAt: date && Number.isFinite(date.getTime()) ? date.toISOString() : null,
  };
}

export function parseCodexUsage(value: unknown): CodexUsage {
  const limits = record(record(value)?.rate_limit);
  const primary = parseWindow(limits?.primary_window);
  const secondary = parseWindow(limits?.secondary_window);
  return primary || secondary ? { status: "available", primary, secondary } : UNAVAILABLE;
}

async function resolveCodexAuth(signal: AbortSignal): Promise<AuthResult | undefined> {
  // 使用 Pi 自身的凭据解析与刷新锁，不读取或改写 auth.json。
  const runtime = await ModelRuntime.create({ refreshOnCreate: false, signal });
  if ((await runtime.checkAuth("openai-codex", { signal }))?.type !== "oauth") return undefined;
  return runtime.getAuth("openai-codex", { signal });
}

interface UsageDependencies {
  resolveAuth?: (signal: AbortSignal) => Promise<AuthResult | undefined>;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  timeoutMs?: number;
}

export function createCodexUsageReader(dependencies: UsageDependencies = {}) {
  const resolveAuth = dependencies.resolveAuth ?? resolveCodexAuth;
  const request = dependencies.fetch ?? ((...args) => globalThis.fetch(...args));
  const now = dependencies.now ?? Date.now;
  let cached: { key: string; expires: number; data: CodexUsage } | undefined;
  let pending: { key: string; promise: Promise<CodexUsage> } | undefined;

  async function load(signal: AbortSignal): Promise<CodexUsage> {
    const resolved = await resolveAuth(signal);
    signal.throwIfAborted();
    const token = resolved?.auth.apiKey;
    if (!token) return UNAVAILABLE;
    // 账户或凭据变化后不能沿用上一账户的缓存。
    const key = createHash("sha256").update(token).digest("hex");
    if (cached?.key === key && cached.expires > now()) return cached.data;
    if (pending?.key === key) return pending.promise;

    const promise = (async (): Promise<CodexUsage> => {
      try {
        const claims = record(JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")));
        const accountId = record(claims?.["https://api.openai.com/auth"])?.chatgpt_account_id;
        if (typeof accountId !== "string" || !accountId) return UNAVAILABLE;
        const response = await request("https://chatgpt.com/backend-api/wham/usage", {
          headers: {
            Authorization: `Bearer ${token}`,
            "ChatGPT-Account-Id": accountId,
            "User-Agent": "codex-cli",
            Accept: "application/json",
          },
          cache: "no-store",
          redirect: "error",
          signal,
        });
        if (!response.ok) return UNAVAILABLE;
        const body: unknown = await response.json();
        signal.throwIfAborted();
        return parseCodexUsage(body);
      } catch {
        // usage 是独立的可选信息，错误和上游响应不得泄漏凭据或影响聊天。
        return UNAVAILABLE;
      }
    })();
    pending = { key, promise };
    const data = await promise;
    cached = { key, data, expires: now() + CACHE_MS };
    if (pending?.promise === promise) pending = undefined;
    return data;
  }

  return async (): Promise<CodexUsage> => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // 同时限制凭据解析、OAuth 刷新和响应体读取的总耗时。
      const timeout = new Promise<CodexUsage>((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve(UNAVAILABLE);
        }, dependencies.timeoutMs ?? TIMEOUT_MS);
      });
      return await Promise.race([load(controller.signal), timeout]);
    } catch {
      return UNAVAILABLE;
    } finally {
      clearTimeout(timer);
    }
  };
}

type UsageGlobal = typeof globalThis & { __piWebCodexUsageReader?: ReturnType<typeof createCodexUsageReader> };
const usageGlobal = globalThis as UsageGlobal;
export const getCodexUsage = usageGlobal.__piWebCodexUsageReader ??= createCodexUsageReader();
