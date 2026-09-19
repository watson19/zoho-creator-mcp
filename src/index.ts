import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { z } from "zod";
import { authorize } from "./oauth";
import { type Env, safeLinkName, zohoGet, zohoGetFile, zohoGetPage } from "./zoho";

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const linkName = z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/);
const environment = z.enum(["production", "development", "stage"]).default("production");

function output(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], structuredContent: value as Record<string, unknown> };
}

function createServer(env: Env) {
  const server = new McpServer({ name: "zoho-creator-read-only", version: "0.4.0" });
  server.registerTool("list_applications", { description: "List every Zoho Creator application accessible to the configured account.", inputSchema: {}, annotations: readOnly }, async () => output(await zohoGet(env, "/creator/v2.1/meta/applications")));
  server.registerTool("list_components", { description: "List forms, reports, pages, or sections in a Zoho Creator application.", inputSchema: { app_link_name: linkName, component: z.enum(["forms", "reports", "pages", "sections"]), environment }, annotations: readOnly }, async ({ app_link_name, component, environment }) => {
    const owner = safeLinkName(env.ZOHO_ACCOUNT_OWNER, "account owner");
    return output(await zohoGet(env, `/creator/v2.1/meta/${owner}/${app_link_name}/${component}`, {}, environment));
  });
  server.registerTool("get_form_fields", { description: "Get field metadata for one form, including link names and field types.", inputSchema: { app_link_name: linkName, form_link_name: linkName, environment }, annotations: readOnly }, async ({ app_link_name, form_link_name, environment }) => {
    const owner = safeLinkName(env.ZOHO_ACCOUNT_OWNER, "account owner");
    return output(await zohoGet(env, `/creator/v2.1/meta/${owner}/${app_link_name}/form/${form_link_name}/fields`, {}, environment));
  });
  server.registerTool("get_records", { description: "Read one cursor-based page from a Creator report. Pass the returned record_cursor into the next call. Zoho v2.1 supports 200, 500, or 1000 records per page.", inputSchema: { app_link_name: linkName, report_link_name: linkName, criteria: z.string().max(2000).optional(), record_cursor: z.string().min(1).max(2000).optional(), max_records: z.union([z.literal(200), z.literal(500), z.literal(1000)]).default(1000), field_config: z.enum(["quick_view", "detail_view", "all"]).default("quick_view"), fields: z.array(linkName).min(1).max(100).optional(), environment }, annotations: readOnly }, async ({ app_link_name, report_link_name, criteria, record_cursor, max_records, field_config, fields, environment }) => {
    const owner = safeLinkName(env.ZOHO_ACCOUNT_OWNER, "account owner");
    return output(await zohoGetPage(env, `/creator/v2.1/data/${owner}/${app_link_name}/report/${report_link_name}`, {
      criteria,
      max_records,
      field_config: fields?.length ? "custom" : field_config,
      fields: fields?.join(",")
    }, record_cursor, environment));
  });
  server.registerTool("count_records", { description: "Count every record matching optional criteria by following Zoho's record_cursor across all pages. Only record IDs are fetched.", inputSchema: { app_link_name: linkName, report_link_name: linkName, criteria: z.string().max(2000).optional(), max_pages: z.number().int().min(1).max(100).default(100), environment }, annotations: readOnly }, async ({ app_link_name, report_link_name, criteria, max_pages, environment }) => {
    const owner = safeLinkName(env.ZOHO_ACCOUNT_OWNER, "account owner");
    const path = `/creator/v2.1/data/${owner}/${app_link_name}/report/${report_link_name}`;
    let cursor: string | undefined;
    let count = 0;
    let pages = 0;
    const seen = new Set<string>();
    do {
      const page = await zohoGetPage(env, path, { criteria, max_records: 1000, field_config: "custom", fields: "ID" }, cursor, environment);
      count += Array.isArray(page.data) ? page.data.length : 0;
      pages += 1;
      const next = typeof page.record_cursor === "string" && page.record_cursor ? page.record_cursor : undefined;
      if (next && seen.has(next)) throw new Error("Zoho returned a repeated record_cursor");
      if (next) seen.add(next);
      cursor = next;
    } while (cursor && pages < max_pages);
    return output({ code: 3000, count, pages, complete: !cursor, record_cursor: cursor });
  });
  server.registerTool("get_all_records", { description: "Read selected fields from consecutive Creator pages automatically. Fields are required to keep large report responses manageable.", inputSchema: { app_link_name: linkName, report_link_name: linkName, fields: z.array(linkName).min(1).max(50), criteria: z.string().max(2000).optional(), max_pages: z.number().int().min(1).max(20).default(10), environment }, annotations: readOnly }, async ({ app_link_name, report_link_name, fields, criteria, max_pages, environment }) => {
    const owner = safeLinkName(env.ZOHO_ACCOUNT_OWNER, "account owner");
    const path = `/creator/v2.1/data/${owner}/${app_link_name}/report/${report_link_name}`;
    const records: unknown[] = [];
    let cursor: string | undefined;
    let pages = 0;
    const seen = new Set<string>();
    do {
      const page = await zohoGetPage(env, path, { criteria, max_records: 1000, field_config: "custom", fields: fields.join(",") }, cursor, environment);
      if (Array.isArray(page.data)) records.push(...page.data);
      pages += 1;
      const next = typeof page.record_cursor === "string" && page.record_cursor ? page.record_cursor : undefined;
      if (next && seen.has(next)) throw new Error("Zoho returned a repeated record_cursor");
      if (next) seen.add(next);
      cursor = next;
    } while (cursor && pages < max_pages);
    return output({ code: 3000, data: records, count: records.length, pages, complete: !cursor, record_cursor: cursor });
  });
  server.registerTool("get_record", { description: "Read one record by its numeric ID from a Creator report.", inputSchema: { app_link_name: linkName, report_link_name: linkName, record_id: z.string().regex(/^\d+$/), environment }, annotations: readOnly }, async ({ app_link_name, report_link_name, record_id, environment }) => {
    const owner = safeLinkName(env.ZOHO_ACCOUNT_OWNER, "account owner");
    return output(await zohoGet(env, `/creator/v2.1/data/${owner}/${app_link_name}/report/${report_link_name}/${record_id}`, {}, environment));
  });
  server.registerTool("get_record_file", { description: "Download an image or file attached to one field of a Creator report record.", inputSchema: { app_link_name: linkName, report_link_name: linkName, record_id: z.string().regex(/^\d+$/), field_link_name: linkName, environment }, annotations: readOnly }, async ({ app_link_name, report_link_name, record_id, field_link_name, environment }) => {
    const owner = safeLinkName(env.ZOHO_ACCOUNT_OWNER, "account owner");
    const recordResponse = await zohoGet(env, `/creator/v2.1/data/${owner}/${app_link_name}/report/${report_link_name}/${record_id}`, {}, environment) as { data?: Record<string, unknown> | Array<Record<string, unknown>> };
    const record = Array.isArray(recordResponse.data) ? recordResponse.data[0] : recordResponse.data;
    const fieldValue = record?.[field_link_name];
    if (typeof fieldValue !== "string" || !fieldValue) throw new Error("The requested record field does not contain a downloadable file");

    const fieldUrl = new URL(fieldValue, "https://creator.zoho.com");
    const filepath = fieldUrl.searchParams.get("filepath") || undefined;
    const file = await zohoGetFile(
      env,
      `/creator/v2.1/data/${owner}/${app_link_name}/report/${report_link_name}/${record_id}/${field_link_name}/download`,
      { filepath },
      environment
    );
    return { content: [{ type: "image" as const, data: file.data, mimeType: file.mimeType }] };
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
    if (url.pathname === "/health") return Response.json({ ok: true, service: "zoho-creator-mcp", version: "0.4.0", mode: "read-only", authentication: "cloudflare-oauth-provider" });
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
