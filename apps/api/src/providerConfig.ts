import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

import { workspaceRootDir } from "./runtimePaths.js";

export type ProviderKind = "openai" | "anthropic";

export interface ProviderConfig {
  provider: ProviderKind;
  apiKey: string;
  baseUrl: string;
  model: string;
  updatedAt: string;
}

export interface ProviderTestResult {
  ok: boolean;
  provider: ProviderKind;
  endpoint: string;
  model: string;
  availableModels: string[];
  selectedModelFound: boolean;
  message: string;
  statusCode?: number;
  requestId?: string;
}

export const DEFAULT_PROVIDER_CONFIG: ProviderConfig = {
  provider: "openai",
  apiKey: "",
  baseUrl: "https://api.openai.com/v1",
  model: "",
  updatedAt: new Date(0).toISOString()
};

export function defaultBaseUrl(provider: ProviderKind): string {
  return provider === "anthropic" ? "https://api.anthropic.com/v1" : "https://api.openai.com/v1";
}

export function normalizeBaseUrl(value: string | undefined, provider: ProviderKind): string {
  const trimmed = value?.trim().replace(/\/+$/, "") ?? "";
  return trimmed.length > 0 ? trimmed : defaultBaseUrl(provider);
}

export function providerEndpoint(config: Pick<ProviderConfig, "provider" | "baseUrl">): string {
  return normalizeBaseUrl(config.baseUrl, config.provider);
}

export function providerConfigSignature(
  config: Pick<ProviderConfig, "provider" | "baseUrl" | "model">
): string {
  const normalized = [
    config.provider,
    normalizeBaseUrl(config.baseUrl, config.provider),
    config.model.trim()
  ].join("|");
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

function providerConfigFile(rootDir = path.join(workspaceRootDir(), ".repo-inspector")): string {
  return path.join(rootDir, "provider-config.json");
}

export class ProviderConfigStore {
  private readonly rootDir: string;
  private readonly filePath: string;
  private cached: ProviderConfig | null = null;

  constructor(rootDir = path.join(workspaceRootDir(), ".repo-inspector")) {
    this.rootDir = rootDir;
    this.filePath = providerConfigFile(rootDir);
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
  }

  async load(): Promise<ProviderConfig> {
    if (this.cached) {
      return this.cached;
    }

    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<ProviderConfig>;
      this.cached = {
        provider: parsed.provider === "anthropic" ? "anthropic" : "openai",
        apiKey: parsed.apiKey ?? "",
        baseUrl: normalizeBaseUrl(parsed.baseUrl, parsed.provider === "anthropic" ? "anthropic" : "openai"),
        model: parsed.model ?? "",
        updatedAt: parsed.updatedAt ?? DEFAULT_PROVIDER_CONFIG.updatedAt
      };
      return this.cached;
    } catch {
      const legacyFilePath = providerConfigFile(path.join(process.cwd(), ".repo-inspector"));
      if (legacyFilePath !== this.filePath && existsSync(legacyFilePath)) {
        const raw = await readFile(legacyFilePath, "utf8");
        const parsed = JSON.parse(raw) as Partial<ProviderConfig>;
        this.cached = {
          provider: parsed.provider === "anthropic" ? "anthropic" : "openai",
          apiKey: parsed.apiKey ?? "",
          baseUrl: normalizeBaseUrl(parsed.baseUrl, parsed.provider === "anthropic" ? "anthropic" : "openai"),
          model: parsed.model ?? "",
          updatedAt: parsed.updatedAt ?? DEFAULT_PROVIDER_CONFIG.updatedAt
        };
        await this.save(this.cached);
        return this.cached;
      }
      this.cached = { ...DEFAULT_PROVIDER_CONFIG };
      return this.cached;
    }
  }

  async save(config: ProviderConfig): Promise<ProviderConfig> {
    await this.ensureDir();
    const next: ProviderConfig = {
      provider: config.provider,
      apiKey: config.apiKey,
      baseUrl: normalizeBaseUrl(config.baseUrl, config.provider),
      model: config.model,
      updatedAt: new Date().toISOString()
    };
    this.cached = next;
    await writeFile(this.filePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    return next;
  }
}

function readHeaderValue(headers: Headers, name: string): string | null {
  const value = headers.get(name);
  return value && value.trim().length > 0 ? value.trim() : null;
}

function extractErrorMessage(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== "object") {
    return fallback;
  }
  const candidate = payload as Record<string, unknown>;
  if (typeof candidate.error === "string") {
    return candidate.error;
  }
  if (candidate.error && typeof candidate.error === "object") {
    const nested = candidate.error as Record<string, unknown>;
    if (typeof nested.message === "string") {
      return nested.message;
    }
  }
  if (typeof candidate.message === "string") {
    return candidate.message;
  }
  return fallback;
}

export async function testProviderConnection(config: ProviderConfig): Promise<ProviderTestResult> {
  if (config.provider !== "openai" && config.provider !== "anthropic") {
    throw new Error(`Unsupported provider: ${config.provider}`);
  }
  if (!config.apiKey.trim()) {
    throw new Error("API key is required");
  }

  const endpoint = providerEndpoint(config);
  let url: URL;
  try {
    url = new URL("/models", `${endpoint}/`);
  } catch {
    throw new Error(`Invalid base URL: ${endpoint}`);
  }
  const headers = new Headers({
    "content-type": "application/json"
  });

  if (config.provider === "openai") {
    headers.set("authorization", `Bearer ${config.apiKey.trim()}`);
  } else {
    headers.set("x-api-key", config.apiKey.trim());
    headers.set("anthropic-version", "2023-06-01");
  }

  const response = await fetch(url, {
    method: "GET",
    headers
  });
  const requestId = readHeaderValue(response.headers, "request-id") ?? readHeaderValue(response.headers, "x-request-id");
  const rawText = await response.text();
  let payload: unknown = null;
  try {
    payload = rawText ? JSON.parse(rawText) : null;
  } catch {
    payload = rawText;
  }

  if (!response.ok) {
    return {
      ok: false,
      provider: config.provider,
      endpoint,
      model: config.model,
      availableModels: [],
      selectedModelFound: false,
      message: extractErrorMessage(payload, `Connection failed with status ${response.status}`),
      statusCode: response.status,
      requestId: requestId ?? undefined
    };
  }

  const models =
    payload && typeof payload === "object" && Array.isArray((payload as Record<string, unknown>).data)
      ? ((payload as Record<string, unknown>).data as Array<Record<string, unknown>>)
          .map((item) => {
            if (typeof item.id === "string") {
              return item.id;
            }
            if (typeof item.name === "string") {
              return item.name;
            }
            return null;
          })
          .filter((item): item is string => Boolean(item))
      : [];

  const selectedModelFound = config.model.trim()
    ? models.some((item) => item === config.model.trim())
    : false;

  return {
    ok: true,
    provider: config.provider,
    endpoint,
    model: config.model,
    availableModels: models.slice(0, 40),
    selectedModelFound,
    message: selectedModelFound || !config.model.trim()
      ? "Connection ok"
      : `Connected, but model ${config.model.trim()} was not found in the model list`,
    statusCode: response.status,
    requestId: requestId ?? undefined
  };
}
