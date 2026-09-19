import { AuthorizationError, type AuthRequest } from "@cloudflare/workers-oauth-provider";
import type { Env } from "./zoho";

const encoder = new TextEncoder();

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

async function secretMatches(submitted: string, expected: string): Promise<boolean> {
  const [submittedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(submitted)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected))
  ]);
  const left = new Uint8Array(submittedHash), right = new Uint8Array(expectedHash);
  let difference = left.length ^ right.length;
  for (let index = 0; index < Math.min(left.length, right.length); index++) difference |= left[index] ^ right[index];
  return difference === 0;
}

function authorizationRequest(request: Request, form?: FormData): Request {
  if (!form) return request;
  const url = new URL(request.url);
  for (const [key, value] of form.entries()) {
    if (key !== "secret" && typeof value === "string") url.searchParams.set(key, value);
  }
  return new Request(url, { method: "GET", headers: request.headers });
}

function authorizationError(error: AuthorizationError): Response {
  if (!error.redirectUri) return new Response(error.description, { status: 400 });
  const redirect = new URL(error.redirectUri);
  redirect.searchParams.set("error", error.code);
  redirect.searchParams.set("error_description", error.description);
  if (error.state) redirect.searchParams.set("state", error.state);
  if (error.issuer) redirect.searchParams.set("iss", error.issuer);
  return Response.redirect(redirect, 302);
}

export async function authorize(request: Request, env: Env): Promise<Response> {
  if (!env.MCP_SHARED_SECRET) return new Response("OAuth is not configured", { status: 503 });
  if (request.method !== "GET" && request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, POST" } });
  }

  const form = request.method === "POST" ? await request.formData() : undefined;
  let oauthRequest: AuthRequest;
  try {
    oauthRequest = await env.OAUTH_PROVIDER.parseAuthRequest(authorizationRequest(request, form));
  } catch (error) {
    if (error instanceof AuthorizationError) return authorizationError(error);
    throw error;
  }

  const client = await env.OAUTH_PROVIDER.lookupClient(oauthRequest.clientId);
  if (!client) return new Response("Unknown OAuth client", { status: 400 });

  if (request.method === "GET") {
    const accessDescription = env.ACCESS_MODE === "read_write" ? "read and write" : "read-only";
    const url = new URL(request.url);
    const hidden = [...url.searchParams.entries()]
      .map(([key, value]) => `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(value)}">`)
      .join("");
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Authorize Zoho Creator</title><style>body{font-family:system-ui,sans-serif;background:#f6f7f9;margin:0;display:grid;place-items:center;min-height:100vh;color:#1f2937}.card{background:white;padding:2rem;border-radius:14px;box-shadow:0 8px 30px #0002;width:min(420px,calc(100% - 3rem))}h1{margin-top:0;font-size:1.45rem}p{line-height:1.5}label{display:block;font-weight:650;margin:1.2rem 0 .4rem}input[type=password]{box-sizing:border-box;width:100%;padding:.8rem;border:1px solid #9ca3af;border-radius:8px;font:inherit}button{width:100%;margin-top:1rem;padding:.85rem;border:0;border-radius:8px;background:#087830;color:white;font:inherit;font-weight:700;cursor:pointer}.note{font-size:.88rem;color:#4b5563}</style></head><body><main class="card"><h1>Authorize Zoho Creator</h1><p><strong>${escapeHtml(client.clientName || "ChatGPT")}</strong> is requesting ${accessDescription} access to your Zoho Creator MCP tools.</p><p class="note">Enter the MCP shared secret stored in Cloudflare to approve this connection.</p><form method="post" action="/authorize">${hidden}<label for="secret">MCP shared secret</label><input id="secret" name="secret" type="password" autocomplete="current-password" required autofocus><button type="submit">Authorize ChatGPT</button></form></main></body></html>`;
    return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://chatgpt.com; base-uri 'none'", "Referrer-Policy": "no-referrer" } });
  }

  if (!await secretMatches(String(form!.get("secret") || ""), env.MCP_SHARED_SECRET)) {
    return new Response("Authorization denied", { status: 401, headers: { "Cache-Control": "no-store" } });
  }

  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthRequest,
    userId: "owner",
    metadata: { clientName: client.clientName || "ChatGPT" },
    scope: oauthRequest.scope.filter((scope) => scope === "mcp"),
    props: { userId: "owner" }
  });
  return Response.redirect(redirectTo, 302);
}
