import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import { authorize, bearerIsValid, completeAuthorization, exchangeToken, oauthMetadata, registerClient, resourceMetadata } from "./oauth";
import { type Env, safeLinkName, zohoGet } from "./zoho";

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const linkName = z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/);
const environment = z.enum(["production", "development", "stage"]).default("production");

function output(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], structuredContent: value as Record<string, unknown> };
}

function createServer(env: Env) {
  const server = new McpServer({ name: "zoho-creator-read-only", version: "0.2.0" });
  server.registerTool("list_applications", { description: "List every Zoho Creator application accessible to the configured account.", inputSchema: {}, annotations: readOnly }, async () => output(await zohoGet(env, "/creator/v2.1/meta/applications")));
  server.registerTool("list_components", { description: "List forms, reports, pages, or sections in a Zoho Creator application.", inputSchema: { app_link_name: linkName, component: z.enum(["forms", "reports", "pages", "sections"]), environment }, annotations: readOnly }, async ({ app_link_name, component, environment }) => {
    const owner = safeLinkName(env.ZOHO_ACCOUNT_OWNER, "account owner");
    return output(await zohoGet(env, `/creator/v2.1/meta/${owner}/${app_link_name}/${component}`, {}, environment));
  });
  server.registerTool("get_form_fields", { description: "Get field metadata for one form, including link names and field types.", inputSchema: { app_link_name: linkName, form_link_name: linkName, environment }, annotations: readOnly }, async ({ app_link_name, form_link_name, environment }) => {
    const owner = safeLinkName(env.ZOHO_ACCOUNT_OWNER, "account owner");
    return output(await zohoGet(env, `/creator/v2.1/meta/${owner}/${app_link_name}/form/${form_link_name}/fields`, {}, environment));
  });
  server.registerTool("get_records", { description: "Read records from a Creator report. Results are capped at 200 records per call.", inputSchema: { app_link_name: linkName, report_link_name: linkName, criteria: z.string().max(2000).optional(), from: z.number().int().min(1).default(1), limit: z.number().int().min(1).max(200).default(200), environment }, annotations: readOnly }, async ({ app_link_name, report_link_name, criteria, from, limit, environment }) => {
    const owner = safeLinkName(env.ZOHO_ACCOUNT_OWNER, "account owner");
    return output(await zohoGet(env, `/creator/v2.1/data/${owner}/${app_link_name}/report/${report_link_name}`, { criteria, from, limit }, environment));
  });
  server.registerTool("get_record", { description: "Read one record by its numeric ID from a Creator report.", inputSchema: { app_link_name: linkName, report_link_name: linkName, record_id: z.string().regex(/^\d+$/), environment }, annotations: readOnly }, async ({ app_link_name, report_link_name, record_id, environment }) => {
    const owner = safeLinkName(env.ZOHO_ACCOUNT_OWNER, "account owner");
    return output(await zohoGet(env, `/creator/v2.1/data/${owner}/${app_link_name}/report/${report_link_name}/${record_id}`, {}, environment));
  });
  return server;
}

function oauthUnauthorized(request: Request): Response {
  const metadata = `${new URL(request.url).origin}/.well-known/oauth-protected-resource`;
  return Response.json({ error: "invalid_token", error_description: "A valid OAuth access token is required" }, {
    status: 401,
    headers: { "WWW-Authenticate": `Bearer resource_metadata="${metadata}", scope="mcp"`, "Cache-Control": "no-store" }
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ ok: true, service: "zoho-creator-mcp", mode: "read-only", authentication: "oauth-2.1-pkce" });
    if (url.pathname === "/.well-known/oauth-protected-resource" || url.pathname === "/.well-known/oauth-protected-resource/mcp") return resourceMetadata(request);
    if (url.pathname === "/.well-known/oauth-authorization-server") return oauthMetadata(request);
    if (url.pathname === "/register") return registerClient(request, env);
    if (url.pathname === "/authorize") return authorize(request, env);
    if (url.pathname === "/oauth/complete") return completeAuthorization(request, env);
    if (url.pathname === "/token") return exchangeToken(request, env);
    if (url.pathname !== "/mcp") return new Response("Not Found", { status: 404 });
    if (!await bearerIsValid(request, env)) return oauthUnauthorized(request);
    return createMcpHandler(() => createServer(env))(request, env, ctx);
  }
} satisfies ExportedHandler<Env>;
