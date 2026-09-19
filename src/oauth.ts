import type { Env } from "./zoho";

type Json = Record<string, unknown>;
type Client = { redirect_uris: string[]; client_name: string; issued_at: number };
type AuthCode = {
  type: "authorization_code";
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  scope: string;
  resource: string;
  exp: number;
  nonce: string;
};
type AccessToken = { type: "access_token"; sub: string; scope: string; aud: string; iat: number; exp: number };

const encoder = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromB64url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function hmac(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value))));
}

async function sign(env: Env, payload: Json): Promise<string> {
  const body = b64url(encoder.encode(JSON.stringify(payload)));
  return `${body}.${await hmac(env.MCP_SHARED_SECRET, body)}`;
}

async function verify<T extends Json>(env: Env, token: string): Promise<T | null> {
  const [body, signature, extra] = token.split(".");
  if (!body || !signature || extra) return null;
  const expected = await hmac(env.MCP_SHARED_SECRET, body);
  if (expected.length !== signature.length) return null;
  let difference = 0;
  for (let index = 0; index < expected.length; index++) difference |= expected.charCodeAt(index) ^ signature.charCodeAt(index);
  if (difference !== 0) return null;
  try {
    return JSON.parse(new TextDecoder().decode(fromB64url(body))) as T;
  } catch {
    return null;
  }
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store", "Pragma": "no-cache" } });
}

function origin(request: Request): string {
  return new URL(request.url).origin;
}

function protectedResource(request: Request): string {
  return `${origin(request)}/mcp`;
}

function validRedirect(uri: string): boolean {
  try {
    const url = new URL(uri);
    return url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
  } catch {
    return false;
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

function randomValue(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return b64url(bytes);
}

async function clientFromId(env: Env, clientId: string): Promise<Client | null> {
  const payload = await verify<Json>(env, clientId);
  if (!payload || !Array.isArray(payload.redirect_uris) || typeof payload.client_name !== "string" || typeof payload.issued_at !== "number") return null;
  return payload as Client;
}

export function oauthMetadata(request: Request): Response {
  const base = origin(request);
  return json({
    issuer: base,
    authorization_response_iss_parameter_supported: true,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    registration_endpoint: `${base}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["mcp"]
  });
}

export function resourceMetadata(request: Request): Response {
  const base = origin(request);
  return json({
    resource: `${base}/mcp`,
    authorization_servers: [base],
    bearer_methods_supported: ["header"],
    scopes_supported: ["mcp"]
  });
}

export async function registerClient(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
  const input = await request.json().catch(() => null) as Json | null;
  const redirects = input?.redirect_uris;
  if (!Array.isArray(redirects) || redirects.length === 0 || redirects.length > 10 || !redirects.every((uri) => typeof uri === "string" && validRedirect(uri))) {
    return json({ error: "invalid_redirect_uri" }, 400);
  }
  const client: Client = {
    redirect_uris: redirects as string[],
    client_name: typeof input?.client_name === "string" ? input.client_name.slice(0, 100) : "ChatGPT",
    issued_at: Math.floor(Date.now() / 1000)
  };
  return json({
    client_id: await sign(env, client as unknown as Json),
    client_id_issued_at: client.issued_at,
    client_name: client.client_name,
    redirect_uris: client.redirect_uris,
    grant_types: ["authorization_code"],
    response_types: ["code"],
    token_endpoint_auth_method: "none"
  }, 201);
}

type AuthorizationRequest = {
  client_id: string;
  redirect_uri: string;
  response_type: string;
  state: string;
  code_challenge: string;
  code_challenge_method: string;
  scope: string;
  resource: string;
};

async function parseAuthorization(request: Request): Promise<AuthorizationRequest> {
  const source = request.method === "POST" ? await request.formData() : new URL(request.url).searchParams;
  const get = (key: string) => String(source.get(key) || "");
  return {
    client_id: get("client_id"), redirect_uri: get("redirect_uri"), response_type: get("response_type"),
    state: get("state"), code_challenge: get("code_challenge"), code_challenge_method: get("code_challenge_method"),
    scope: get("scope") || "mcp", resource: get("resource")
  };
}

async function validAuthorization(env: Env, input: AuthorizationRequest, request: Request): Promise<Client | null> {
  const client = await clientFromId(env, input.client_id);
  if (!client || !client.redirect_uris.includes(input.redirect_uri)) return null;
  if (input.response_type !== "code" || input.code_challenge_method !== "S256" || !/^[A-Za-z0-9_-]{43,128}$/.test(input.code_challenge)) return null;
  if (input.scope.split(/\s+/).some((scope) => scope !== "mcp")) return null;
  if (input.resource && input.resource !== protectedResource(request)) return null;
  return client;
}

export async function authorize(request: Request, env: Env): Promise<Response> {
  if (!env.MCP_SHARED_SECRET) return new Response("OAuth is not configured", { status: 503 });
  const formRequest = request.method === "POST" ? request.clone() : null;
  const input = await parseAuthorization(request);
  const client = await validAuthorization(env, input, request);
  if (!client) return json({ error: "invalid_request", error_description: "Invalid OAuth authorization request" }, 400);

  if (request.method === "GET") {
    const hidden = Object.entries(input).map(([key, value]) => `<input type="hidden" name="${key}" value="${escapeHtml(value)}">`).join("");
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Authorize Zoho Creator</title><style>body{font-family:system-ui,sans-serif;background:#f6f7f9;margin:0;display:grid;place-items:center;min-height:100vh;color:#1f2937}.card{background:white;padding:2rem;border-radius:14px;box-shadow:0 8px 30px #0002;width:min(420px,calc(100% - 3rem))}h1{margin-top:0;font-size:1.45rem}p{line-height:1.5}label{display:block;font-weight:650;margin:1.2rem 0 .4rem}input[type=password]{box-sizing:border-box;width:100%;padding:.8rem;border:1px solid #9ca3af;border-radius:8px;font:inherit}button{width:100%;margin-top:1rem;padding:.85rem;border:0;border-radius:8px;background:#087830;color:white;font:inherit;font-weight:700;cursor:pointer}.note{font-size:.88rem;color:#4b5563}</style></head><body><main class="card"><h1>Authorize Zoho Creator</h1><p><strong>${escapeHtml(client.client_name)}</strong> is requesting read-only access to your Zoho Creator MCP tools.</p><p class="note">This does not reveal your Zoho credentials. Enter the MCP shared secret stored in Cloudflare to approve this connection.</p><form method="post" action="/authorize">${hidden}<label for="secret">MCP shared secret</label><input id="secret" name="secret" type="password" autocomplete="current-password" required autofocus><button type="submit">Authorize ChatGPT</button></form></main></body></html>`;
    return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'", "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer" } });
  }

  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, POST" } });
  const form = await formRequest!.formData();
  const submitted = String(form.get("secret") || "");
  const submittedHash = await crypto.subtle.digest("SHA-256", encoder.encode(submitted));
  const expectedHash = await crypto.subtle.digest("SHA-256", encoder.encode(env.MCP_SHARED_SECRET));
  const left = new Uint8Array(submittedHash), right = new Uint8Array(expectedHash);
  let difference = left.length ^ right.length;
  for (let index = 0; index < Math.min(left.length, right.length); index++) difference |= left[index] ^ right[index];
  if (difference !== 0) return new Response("Authorization denied", { status: 401, headers: { "Cache-Control": "no-store" } });

  const now = Math.floor(Date.now() / 1000);
  const code: AuthCode = {
    type: "authorization_code", client_id: input.client_id, redirect_uri: input.redirect_uri,
    code_challenge: input.code_challenge, scope: "mcp", resource: input.resource || protectedResource(request),
    exp: now + 300, nonce: randomValue()
  };
  const completion = new URL("/oauth/complete", origin(request));
  completion.searchParams.set("code", await sign(env, code as unknown as Json));
  if (input.state) completion.searchParams.set("state", input.state);
  return Response.redirect(completion.toString(), 303);
}

export async function completeAuthorization(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET" } });
  const source = new URL(request.url).searchParams;
  const signedCode = source.get("code") || "";
  const code = await verify<AuthCode & Json>(env, signedCode);
  const now = Math.floor(Date.now() / 1000);
  if (!code || code.type !== "authorization_code" || code.exp < now || !validRedirect(code.redirect_uri)) {
    return json({ error: "invalid_request", error_description: "Invalid or expired OAuth authorization response" }, 400);
  }
  const destination = new URL(code.redirect_uri);
  destination.searchParams.set("code", signedCode);
  const state = source.get("state");
  if (state) destination.searchParams.set("state", state);
  destination.searchParams.set("iss", origin(request));
  return Response.redirect(destination.toString(), 302);
}

export async function exchangeToken(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
  const form = await request.formData();
  if (form.get("grant_type") !== "authorization_code") return json({ error: "unsupported_grant_type" }, 400);
  const code = await verify<AuthCode & Json>(env, String(form.get("code") || ""));
  const clientId = String(form.get("client_id") || "");
  const redirectUri = String(form.get("redirect_uri") || "");
  const verifier = String(form.get("code_verifier") || "");
  const now = Math.floor(Date.now() / 1000);
  if (!code || code.type !== "authorization_code" || code.exp < now || code.client_id !== clientId || code.redirect_uri !== redirectUri || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) {
    return json({ error: "invalid_grant" }, 400);
  }
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(verifier))));
  if (challenge !== code.code_challenge) return json({ error: "invalid_grant" }, 400);
  const lifetime = 30 * 24 * 60 * 60;
  const access: AccessToken = { type: "access_token", sub: "owner", scope: "mcp", aud: code.resource, iat: now, exp: now + lifetime };
  return json({ access_token: await sign(env, access as unknown as Json), token_type: "Bearer", expires_in: lifetime, scope: "mcp" });
}

export async function bearerIsValid(request: Request, env: Env): Promise<boolean> {
  const match = /^Bearer\s+(.+)$/i.exec(request.headers.get("Authorization") || "");
  if (!match) return false;
  const payload = await verify<AccessToken & Json>(env, match[1]);
  const now = Math.floor(Date.now() / 1000);
  return Boolean(payload && payload.type === "access_token" && payload.exp >= now && payload.aud === protectedResource(request) && payload.scope.split(/\s+/).includes("mcp"));
}
