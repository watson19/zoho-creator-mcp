export type TokenCredentials = {
  accountsUrl: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  apiDomain?: string;
};
export type CachedToken = { accessToken: string; apiDomain: string; expiresAt: number };
export type TokenRequest = TokenCredentials & { rejectedAccessToken?: string };
type State = { token?: CachedToken; failure?: { message: string; retryAt: number } };
export interface TokenStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<unknown>;
}

export function accountsOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.port || url.username || url.password || !/^accounts\.zoho\.(com|eu|in|com\.au|jp|ca|sa)$/.test(url.hostname)) {
    throw new Error("ZOHO_ACCOUNTS_URL is not an approved Zoho accounts host");
  }
  return url.origin;
}

export async function credentialKey(credentials: TokenCredentials): Promise<string> {
  if (![credentials.clientId, credentials.clientSecret, credentials.refreshToken].every(value => typeof value === "string" && value.length > 0)) {
    throw new Error("Zoho OAuth credentials are incomplete");
  }
  const identity = JSON.stringify([accountsOrigin(credentials.accountsUrl), credentials.clientId, credentials.clientSecret, credentials.refreshToken, credentials.apiDomain || ""]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

function safeDetail(value: unknown, request: TokenRequest): string {
  let text = typeof value === "string" ? value : "";
  for (const secret of [request.clientId, request.clientSecret, request.refreshToken, request.rejectedAccessToken]) {
    if (secret) {
      text = text.split(secret).join("[redacted]");
      text = text.split(encodeURIComponent(secret)).join("[redacted]");
    }
  }
  return text.replace(/1000\.[A-Za-z0-9._-]+/g, "[redacted]").replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 350);
}

// One coordinator per credential fingerprint, backed by one Durable Object.
// Neither refresh tokens nor client secrets are persisted in storage.
export class TokenCoordinator {
  private state: State = {};
  private ready: Promise<void>;
  private refreshing?: Promise<CachedToken>;

  constructor(private storage: TokenStorage, private fetcher: typeof fetch = (...args) => fetch(...args), private now: () => number = Date.now) {
    this.ready = storage.get<State>("state").then(state => { this.state = state || {}; });
  }

  async get(request: TokenRequest): Promise<CachedToken> {
    await this.ready;
    const cached = this.state.token;
    if (cached && cached.expiresAt > this.now() + 60_000 && cached.accessToken !== request.rejectedAccessToken) return cached;
    if (this.refreshing) return this.refreshing;
    if (this.state.failure && this.state.failure.retryAt > this.now()) {
      throw new Error(`${this.state.failure.message}; retry after ${Math.ceil((this.state.failure.retryAt - this.now()) / 1000)} seconds`);
    }
    this.refreshing = this.refresh(request);
    try { return await this.refreshing; }
    finally { this.refreshing = undefined; }
  }

  private async refresh(request: TokenRequest): Promise<CachedToken> {
    const accounts = accountsOrigin(request.accountsUrl);
    const body = new URLSearchParams({ refresh_token: request.refreshToken, client_id: request.clientId, client_secret: request.clientSecret, grant_type: "refresh_token" });
    let delay = 30_000;
    try {
      const response = await this.fetcher(new URL("/oauth/v2/token", accounts), { method: "POST", body, signal: AbortSignal.timeout(15_000) });
      const data = await response.json().catch(() => ({})) as Record<string, unknown>;
      if (!response.ok || typeof data.access_token !== "string" || !data.access_token) {
        const code = safeDetail(data.error, request) || "unknown_error";
        const detail = safeDetail(data.error_description, request);
        // Persist a cooldown so new runtime instances cannot hammer Zoho either.
        if (response.status === 429 || /access denied|too many|throttl|rate limit|maximum request/i.test(`${code} ${detail}`)) delay = 600_000;
        throw new Error(`Zoho token refresh failed: ${code} (HTTP ${response.status})${detail ? `: ${detail}` : ""}`);
      }
      const apiUrl = new URL(String(data.api_domain || request.apiDomain || ""));
      if (apiUrl.protocol !== "https:" || apiUrl.port || apiUrl.username || apiUrl.password || !/^www\.zohoapis\.(com|eu|in|com\.au|jp|ca|sa)$/.test(apiUrl.hostname)) throw new Error("Zoho returned an unapproved API domain");
      const lifetime = Number(data.expires_in ?? 3600);
      if (!Number.isFinite(lifetime) || lifetime <= 60) throw new Error("Zoho returned an invalid token lifetime");
      const token = { accessToken: data.access_token, apiDomain: apiUrl.origin, expiresAt: this.now() + lifetime * 1000 };
      await this.storage.put("state", { token });
      this.state = { token };
      return token;
    } catch (error) {
      const message = safeDetail(error instanceof Error ? error.message : "Zoho token refresh failed", request);
      this.state = { failure: { message, retryAt: this.now() + delay } };
      await this.storage.put("state", this.state);
      throw new Error(message);
    }
  }
}
