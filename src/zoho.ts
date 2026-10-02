import { accountsOrigin, credentialKey, type CachedToken, type TokenCredentials } from "./token-cache";
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface Env {
  MCP_SHARED_SECRET: string;
  OAUTH_KV: KVNamespace;
  ZOHO_TOKEN_BROKER: DurableObjectNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  ZOHO_CLIENT_ID: string;
  ZOHO_CLIENT_SECRET: string;
  ZOHO_REFRESH_TOKEN: string;
  ZOHO_ACCOUNTS_URL?: string;
  ZOHO_ACCOUNTS_DOMAIN?: string;
  ZOHO_API_DOMAIN?: string;
  ZOHO_ACCOUNT_OWNER: string;
  ACCESS_MODE?: "read_only" | "read_write";
  WRITE_ALLOWED_APPS?: string;
  WRITE_ALLOWED_FORMS?: string;
  WRITE_ALLOWED_REPORTS?: string;
  AUDIT_RETENTION_DAYS?: string;
  CUSTOM_API_ALLOWED_NAMES?: string;
}

const LINK_NAME = /^[A-Za-z0-9_-]+$/;
const ENVIRONMENTS = new Set(["production", "development", "stage"]);

export function safeLinkName(value: string, label: string): string {
  if (!LINK_NAME.test(value)) throw new Error(`${label} contains unsupported characters`);
  return value;
}

export function safeEnvironment(value: string): string {
  if (!ENVIRONMENTS.has(value)) throw new Error("environment must be production, development, or stage");
  return value;
}

async function token(env: Env, rejectedAccessToken?: string): Promise<CachedToken> {
  if (!env.ZOHO_TOKEN_BROKER) throw new Error("Shared Zoho token coordinator is not configured");
  const credentials: TokenCredentials = {
    accountsUrl: accountsOrigin(env.ZOHO_ACCOUNTS_URL || env.ZOHO_ACCOUNTS_DOMAIN || "https://accounts.zoho.com"),
    clientId: env.ZOHO_CLIENT_ID,
    clientSecret: env.ZOHO_CLIENT_SECRET,
    refreshToken: env.ZOHO_REFRESH_TOKEN,
    apiDomain: env.ZOHO_API_DOMAIN
  };
  const key = await credentialKey(credentials);
  const broker = env.ZOHO_TOKEN_BROKER.get(env.ZOHO_TOKEN_BROKER.idFromName(key));
  const response = await broker.fetch(`https://token-broker/${key}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...credentials, rejectedAccessToken })
  });
  const data = await response.json() as CachedToken & { error?: string };
  if (!response.ok) throw new Error(data.error || "Shared Zoho token coordinator failed");
  return data;
}

export async function zohoGet(
  env: Env,
  path: string,
  query: Record<string, string | number | undefined> = {},
  environment = "production"
): Promise<unknown> {
  let rejectedAccessToken: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const credentials = await token(env, rejectedAccessToken);
    const url = new URL(path, credentials.apiDomain);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
    }
    const headers: Record<string, string> = { Authorization: `Zoho-oauthtoken ${credentials.accessToken}` };
    if (environment !== "production") headers.environment = safeEnvironment(environment);

    const response = await fetch(url, { headers });
    const data = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (response.status === 401 && attempt === 0) { rejectedAccessToken = credentials.accessToken; continue; }
    if (!response.ok || (typeof data.code === "number" && data.code !== 3000)) {
      const message = typeof data.message === "string" ? data.message : "Zoho request failed";
      throw new Error(`${message} (HTTP ${response.status})`);
    }
    return data;
  }
  throw new Error("Zoho request failed after token refresh");
}

export async function zohoGetPage(
  env: Env,
  path: string,
  query: Record<string, string | number | undefined> = {},
  recordCursor?: string,
  environment = "production"
): Promise<Record<string, unknown>> {
  let rejectedAccessToken: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const credentials = await token(env, rejectedAccessToken);
    const url = new URL(path, credentials.apiDomain);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
    }
    const headers: Record<string, string> = { Authorization: `Zoho-oauthtoken ${credentials.accessToken}` };
    if (recordCursor) headers.record_cursor = recordCursor;
    if (environment !== "production") headers.environment = safeEnvironment(environment);

    const response = await fetch(url, { headers });
    const data = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (response.status === 401 && attempt === 0) { rejectedAccessToken = credentials.accessToken; continue; }
    if (!response.ok || (typeof data.code === "number" && data.code !== 3000)) {
      const message = typeof data.message === "string" ? data.message : "Zoho request failed";
      throw new Error(`${message} (HTTP ${response.status})`);
    }

    const nextCursor = response.headers.get("record_cursor");
    if (nextCursor && typeof data.record_cursor !== "string") data.record_cursor = nextCursor;
    return data;
  }
  throw new Error("Zoho request failed after token refresh");
}

export async function zohoGetFile(
  env: Env,
  path: string,
  query: Record<string, string | number | undefined> = {},
  environment = "production"
): Promise<{ data: string; mimeType: string }> {
  let rejectedAccessToken: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const credentials = await token(env, rejectedAccessToken);
    const url = new URL(path, credentials.apiDomain);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
    }
    const headers: Record<string, string> = { Authorization: `Zoho-oauthtoken ${credentials.accessToken}` };
    if (environment !== "production") headers.environment = safeEnvironment(environment);

    const response = await fetch(url, { headers });
    if (response.status === 401 && attempt === 0) { rejectedAccessToken = credentials.accessToken; continue; }
    if (!response.ok) throw new Error(`Zoho file download failed (HTTP ${response.status})`);

    const mimeType = (response.headers.get("content-type") || "application/octet-stream").split(";")[0];
    const bytes = new Uint8Array(await response.arrayBuffer());
    let binary = "";
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    }
    return { data: btoa(binary), mimeType };
  }
  throw new Error("Zoho file download failed after token refresh");
}

export async function zohoCustomApiRequest(
  env: Env,
  customApiName: string,
  method: "GET" | "POST" | "PUT" | "DELETE",
  query: Record<string, string | number | boolean | undefined> = {},
  body?: unknown
): Promise<{ status: number; contentType: string; data: unknown }> {
  if (env.ACCESS_MODE !== "read_write") throw new Error("This connector is read-only");

  const owner = safeLinkName(env.ZOHO_ACCOUNT_OWNER, "account owner");
  const apiName = safeLinkName(customApiName, "custom API name");
  let rejectedAccessToken: string | undefined;

  for (let attempt = 0; attempt < 2; attempt++) {
    const credentials = await token(env, rejectedAccessToken);
    const url = new URL(`/creator/custom/${owner}/${apiName}`, credentials.apiDomain);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
    }

    const headers: Record<string, string> = {
      Authorization: `Zoho-oauthtoken ${credentials.accessToken}`
    };
    const init: RequestInit = { method, headers };
    if (method !== "GET" && body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    const response = await fetch(url, init);
    const contentType = (response.headers.get("content-type") || "application/octet-stream").split(";")[0];
    const raw = await response.text();
    let data: unknown = raw;
    if (raw) {
      try { data = JSON.parse(raw); } catch { /* Preserve non-JSON custom responses as text. */ }
    } else {
      data = null;
    }

    if (response.status === 401 && attempt === 0) {
      rejectedAccessToken = credentials.accessToken;
      continue;
    }
    if (!response.ok) {
      const object = data && typeof data === "object" ? data as Record<string, unknown> : undefined;
      const message = typeof object?.message === "string"
        ? object.message
        : typeof object?.error === "string"
          ? object.error
          : typeof data === "string" && data
            ? data
            : "Zoho Custom API request failed";
      throw new Error(`${message} (HTTP ${response.status})`);
    }

    return { status: response.status, contentType, data };
  }
  throw new Error("Zoho Custom API request failed after token refresh");
}

export async function zohoMutate(
  env: Env,
  path: string,
  method: "POST" | "PATCH",
  body: Record<string, unknown>,
  query: Record<string, string | number | undefined> = {},
  environment = "production"
): Promise<Record<string, unknown>> {
  if (env.ACCESS_MODE !== "read_write") throw new Error("This connector is read-only");

  let rejectedAccessToken: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const credentials = await token(env, rejectedAccessToken);
    const url = new URL(path, credentials.apiDomain);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
    }
    const headers: Record<string, string> = {
      Authorization: `Zoho-oauthtoken ${credentials.accessToken}`,
      "Content-Type": "application/json"
    };
    if (environment !== "production") headers.environment = safeEnvironment(environment);

    const response = await fetch(url, { method, headers, body: JSON.stringify(body) });
    const data = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (response.status === 401 && attempt === 0) { rejectedAccessToken = credentials.accessToken; continue; }
    const resultItems = Array.isArray(data.result) ? data.result.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object") : [];
    const failedResult = resultItems.find((item) => typeof item.code === "number" && item.code !== 3000);
    if (!response.ok || (typeof data.code === "number" && data.code !== 3000) || failedResult) {
      const nestedError = failedResult?.error;
      const message = typeof failedResult?.message === "string"
        ? failedResult.message
        : nestedError && typeof nestedError === "object" && typeof (nestedError as Record<string, unknown>).message === "string"
          ? String((nestedError as Record<string, unknown>).message)
          : typeof data.message === "string"
            ? data.message
            : failedResult ? `Zoho mutation failed: ${JSON.stringify(failedResult)}` : `Zoho mutation failed: ${JSON.stringify(data)}`;
      throw new Error(`${message} (HTTP ${response.status})`);
    }
    return data;
  }
  throw new Error("Zoho mutation failed after token refresh");
}
