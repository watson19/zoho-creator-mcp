import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { z } from "zod";
import { authorize } from "./oauth";
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

const apiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return createMcpHandler(() => createServer(env))(request, env, ctx);
  }
} satisfies ExportedHandler<Env>;

const defaultHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ ok: true, service: "zoho-creator-mcp", mode: "read-only", authentication: "cloudflare-oauth-provider" });
    if (url.pathname === "/authorize") return authorize(request, env);
    return new Response("Not Found", { status: 404 });
  }
} satisfies ExportedHandler<Env>;

const base = "https://zoho-creator-mcp.ec4c5111f2c81375a3b2ae75ae7d3c37ceca2fa0.workers.dev";

export default new OAuthProvider<Env>({
  apiRoute: "/mcp",
  apiHandler,
  defaultHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  scopesSupported: ["mcp"],
  resourceMetadata: {
    resource: `${base}/mcp`,
    authorization_servers: [base],
    scopes_supported: ["mcp"],
    bearer_methods_supported: ["header"],
    resource_name: "Zoho Creator MCP"
  },
  // ChatGPT's CIMD prefers private_key_jwt, which this provider does not
  // implement. Use DCR so the client and server negotiate a supported token
  // endpoint authentication method instead of looping after authorization.
  clientIdMetadataDocumentEnabled: false,
  accessTokenTTL: 60 * 60,
  refreshTokenTTL: 30 * 24 * 60 * 60
});
