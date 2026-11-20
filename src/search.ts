import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { type Env, safeLinkName, zohoGetPage } from "./zoho";
const linkName = z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/);
const environment = z.enum(["production", "development", "stage"]).default("production");
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
function output(value: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], structuredContent: value };
}
export function registerBulkSearchTools(server: McpServer, env: Env): void {
  server.registerTool("bulk_search_records", {
    description: "Search a report for up to 50 exact values in one field and read consecutive pages. Use value_type number for numeric fields, otherwise string. Returns a continuation cursor when incomplete.",
    inputSchema: {
      app_link_name: linkName, report_link_name: linkName, field_link_name: linkName,
      values: z.array(z.string().min(1).max(100)).min(1).max(50),
      value_type: z.enum(["string", "number"]).default("string"),
      fields: z.array(linkName).min(1).max(50),
      max_pages: z.number().int().min(1).max(20).default(10),
      record_cursor: z.string().min(1).max(2000).optional(), environment
    },
    annotations: readOnly
  }, async ({ app_link_name, report_link_name, field_link_name, values, value_type, fields, max_pages, record_cursor, environment }) => {
    const unique = [...new Set(values)];
    if (value_type === "number" && unique.some(value => !/^-?\d+(\.\d+)?$/.test(value))) {
      throw new Error("Numeric search values must be decimal numbers");
    }
    const criteria = `(${unique.map(value => `${field_link_name}==${value_type === "number" ? value : JSON.stringify(value)}`).join(" || ")})`;
    const owner = safeLinkName(env.ZOHO_ACCOUNT_OWNER, "account owner");
    const path = `/creator/v2.1/data/${owner}/${app_link_name}/report/${report_link_name}`;
    const records: unknown[] = [];
    let cursor = record_cursor;
    let pages = 0;
    const seen = new Set<string>(cursor ? [cursor] : []);
    do {
      const page = await zohoGetPage(env, path, { criteria, max_records: 1000, field_config: "custom", fields: [...new Set(["ID", field_link_name, ...fields])].join(",") }, cursor, environment);
      if (Array.isArray(page.data)) records.push(...page.data);
      pages++;
      const next = typeof page.record_cursor === "string" && page.record_cursor ? page.record_cursor : undefined;
      if (next && seen.has(next)) throw new Error("Zoho returned a repeated record_cursor");
      if (next) seen.add(next);
      cursor = next;
    } while (cursor && pages < max_pages);
    return output({ code: 3000, data: records, count: records.length, pages, complete: !cursor, record_cursor: cursor });
  });
}
