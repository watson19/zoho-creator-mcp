import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { type Env, zohoCustomApiRequest } from "./zoho";

const invokeWrite = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
const linkName = z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/);
const method = z.enum(["GET", "POST", "PUT", "DELETE"]).default("POST");
const queryValue = z.union([z.string().max(5000), z.number(), z.boolean()]);
const querySchema = z.record(
  z.string().min(1).max(100).regex(/^[A-Za-z][A-Za-z0-9_]*$/),
  queryValue
).refine((value) => Object.keys(value).length <= 50, "query may contain at most 50 parameters");
const bodySchema = z.record(z.string().min(1).max(200), z.unknown()).refine(
  (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 64 * 1024,
  "body exceeds the 64 KB safety limit"
);

function output(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value as Record<string, unknown>
  };
}

function csvSet(value?: string): Set<string> {
  return new Set((value || "").split(",").map((item) => item.trim()).filter(Boolean));
}

function assertAllowed(env: Env, customApiName: string): void {
  const allowed = csvSet(env.CUSTOM_API_ALLOWED_NAMES);
  if (!allowed.has(customApiName)) {
    throw new Error(`Custom API is not allowed: ${customApiName}`);
  }
}

function auditToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function audit(env: Env, event: Record<string, unknown>): Promise<void> {
  const now = Date.now();
  const retention = Math.max(1, Math.min(365, Number(env.AUDIT_RETENTION_DAYS || 90)));
  await env.OAUTH_KV.put(
    `audit:${String(now).padStart(13, "0")}:${auditToken()}`,
    JSON.stringify({ timestamp: new Date(now).toISOString(), actor: "admin-connector", ...event }),
    { expirationTtl: retention * 86400 }
  );
}

export function registerCustomApiTools(server: McpServer, env: Env): void {
  server.registerTool(
    "invoke_custom_api",
    {
      description: "Invoke one server-allowlisted Zoho Creator Custom API using OAuth. Custom APIs can execute arbitrary Creator logic, so every invocation requires explicit user confirmation.",
      inputSchema: {
        custom_api_name: linkName,
        method,
        query: querySchema.optional(),
        body: bodySchema.optional(),
        confirmed: z.literal(true)
      },
      annotations: invokeWrite
    },
    async ({ custom_api_name, method, query, body, confirmed }) => {
      void confirmed;
      assertAllowed(env, custom_api_name);
      if (method === "GET" && body !== undefined) throw new Error("GET Custom API invocations cannot include a JSON body");

      try {
        const result = await zohoCustomApiRequest(env, custom_api_name, method, query || {}, body);
        await audit(env, {
          action: "invoke_custom_api",
          custom_api_name,
          method,
          result: "completed",
          http_status: result.status
        });
        return output({
          code: 3000,
          action: "invoke_custom_api",
          custom_api_name,
          method,
          http_status: result.status,
          content_type: result.contentType,
          response: result.data
        });
      } catch (error) {
        await audit(env, {
          action: "invoke_custom_api",
          custom_api_name,
          method,
          result: "failed",
          error: error instanceof Error ? error.message : String(error)
        }).catch(() => undefined);
        throw error;
      }
    }
  );
}
