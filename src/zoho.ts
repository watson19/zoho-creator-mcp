import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface Env {
  MCP_SHARED_SECRET: string;
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  ZOHO_CLIENT_ID: string;
  ZOHO_CLIENT_SECRET: string;
  ZOHO_REFRESH_TOKEN: string;
  ZOHO_ACCOUNTS_URL?: string;
  ZOHO_ACCOUNTS_DOMAIN?: string;
  ZOHO_API_DOMAIN?: string;
  ZOHO_ACCOUNT_OWNER: string;
}

type TokenCache = { accessToken: string; apiDomain: string; expiresAt: number };
let tokenCache: TokenCache | undefined;

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

async function token(env: Env): Promise<TokenCache> {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) return tokenCache;

  const accounts = new URL(env.ZOHO_ACCOUNTS_URL || env.ZOHO_ACCOUNTS_DOMAIN || "https://accounts.zoho.com");
  if (accounts.protocol !== "https:" || !/^accounts\.zoho\.(com|eu|in|com\.au|jp|ca|sa)$/.test(accounts.hostname)) {
    throw new Error("ZOHO_ACCOUNTS_URL is not an approved Zoho accounts host");
  }
  const body = new URLSearchParams({
    refresh_token: env.ZOHO_REFRESH_TOKEN,
    client_id: env.ZOHO_CLIENT_ID,
    client_secret: env.ZOHO_CLIENT_SECRET,
    grant_type: "refresh_token"
  });
  const response = await fetch(new URL("/oauth/v2/token", accounts), { method: "POST", body });
  const data = await response.json() as Record<string, unknown>;
  if (!response.ok || typeof data.access_token !== "string") {
    const errorCode = typeof data.error === "string" ? data.error : "unknown_error";
    throw new Error(`Zoho token refresh failed: ${errorCode} (HTTP ${response.status})`);
  }
  const apiDomain = String(data.api_domain || env.ZOHO_API_DOMAIN || "");
  const apiUrl = new URL(apiDomain);
  if (apiUrl.protocol !== "https:" || !/^www\.zohoapis\.(com|eu|in|com\.au|jp|ca|sa)$/.test(apiUrl.hostname)) {
    throw new Error("Zoho returned an unapproved API domain");
  }
  tokenCache = {
    accessToken: data.access_token,
    apiDomain: apiUrl.origin,
    expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000
  };
  return tokenCache;
}

export async function zohoGet(
  env: Env,
  path: string,
  query: Record<string, string | number | undefined> = {},
  environment = "production"
): Promise<unknown> {
  const credentials = await token(env);
  const url = new URL(path, credentials.apiDomain);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
  }
  const headers: Record<string, string> = { Authorization: `Zoho-oauthtoken ${credentials.accessToken}` };
  if (environment !== "production") headers.environment = safeEnvironment(environment);

  const response = await fetch(url, { headers });
  const data = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok || (typeof data.code === "number" && data.code !== 3000)) {
    const message = typeof data.message === "string" ? data.message : "Zoho request failed";
    throw new Error(`${message} (HTTP ${response.status})`);
  }
  return data;
}

export async function zohoGetFile(
  env: Env,
  path: string,
  query: Record<string, string | number | undefined> = {},
  environment = "production"
): Promise<{ data: string; mimeType: string }> {
  const credentials = await token(env);
  const url = new URL(path, credentials.apiDomain);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
  }
  const headers: Record<string, string> = { Authorization: `Zoho-oauthtoken ${credentials.accessToken}` };
  if (environment !== "production") headers.environment = safeEnvironment(environment);

  const response = await fetch(url, { headers });
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
