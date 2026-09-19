import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { type Env, safeLinkName, zohoGet, zohoMutate } from "./zoho";

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const createWrite = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const updateWrite = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
const linkName = z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/);
const recordId = z.string().regex(/^\d+$/);
const environment = z.enum(["production", "development", "stage"]).default("production");
const recordData = z.record(z.string(), z.unknown()).refine((value) => Object.keys(value).length > 0 && Object.keys(value).length <= 100, "data must contain 1 to 100 fields");

type JsonRecord = Record<string, unknown>;
type Confirmation = {
  action: "create" | "update";
  target: string;
  payloadHash: string;
  beforeHash?: string;
  expiresAt: number;
};

function output(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], structuredContent: value as Record<string, unknown> };
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as JsonRecord;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stable(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function hash(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stable(value)));
  return base64Url(new Uint8Array(digest));
}

function token(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

function csvSet(value?: string): Set<string> {
  return new Set((value || "").split(",").map((item) => item.trim()).filter(Boolean));
}

function assertWriteTarget(env: Env, app: string, kind: "form" | "report", component: string): void {
  const apps = csvSet(env.WRITE_ALLOWED_APPS);
  const components = csvSet(kind === "form" ? env.WRITE_ALLOWED_FORMS : env.WRITE_ALLOWED_REPORTS);
  if (!apps.has(app) || !components.has(`${app}/${component}`)) {
    throw new Error(`Write access is not allowed for ${app}/${component}`);
  }
}

function validateData(data: JsonRecord): void {
  const encoded = new TextEncoder().encode(JSON.stringify(data));
  if (encoded.byteLength > 64 * 1024) throw new Error("Record data exceeds the 64 KB safety limit");
  for (const field of Object.keys(data)) safeLinkName(field, "field link name");
  if (Object.prototype.hasOwnProperty.call(data, "ID")) throw new Error("The ID field cannot be written");
}

async function validateFormFields(env: Env, app: string, form: string, data: JsonRecord, envName: string): Promise<void> {
  const owner = safeLinkName(env.ZOHO_ACCOUNT_OWNER, "account owner");
  const response = await zohoGet(env, `/creator/v2.1/meta/${owner}/${app}/form/${form}/fields`, {}, envName) as { fields?: Array<JsonRecord> };
  const allowed = new Set((response.fields || []).map((field) => field.link_name).filter((value): value is string => typeof value === "string"));
  const unknown = Object.keys(data).filter((field) => !allowed.has(field));
  if (unknown.length) throw new Error(`Unknown form field link name(s): ${unknown.join(", ")}`);
}

async function getRecord(env: Env, app: string, report: string, id: string, envName: string): Promise<JsonRecord> {
  const owner = safeLinkName(env.ZOHO_ACCOUNT_OWNER, "account owner");
  const response = await zohoGet(env, `/creator/v2.1/data/${owner}/${app}/report/${report}/${id}`, {}, envName) as { data?: JsonRecord | JsonRecord[] };
  const record = Array.isArray(response.data) ? response.data[0] : response.data;
  if (!record) throw new Error("Zoho record was not found");
  return record;
}

function subset(record: JsonRecord, fields: string[]): JsonRecord {
  return Object.fromEntries(fields.map((field) => [field, record[field] ?? null]));
}

function containsExpected(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && actual.length === expected.length && expected.every((value, index) => containsExpected(actual[index], value));
  }
  if (expected && typeof expected === "object") {
    if (!actual || typeof actual !== "object" || Array.isArray(actual)) return false;
    const actualObject = actual as JsonRecord;
    return Object.entries(expected as JsonRecord).every(([key, value]) => containsExpected(actualObject[key], value));
  }
  return actual === expected || String(actual) === String(expected);
}

function mismatchedFields(actual: JsonRecord, expected: JsonRecord): string[] {
  return Object.keys(expected).filter((field) => !containsExpected(actual[field], expected[field]));
}

async function prepareConfirmation(env: Env, confirmation: Omit<Confirmation, "expiresAt">): Promise<{ confirmationToken: string; expiresAt: string }> {
  const confirmationToken = token();
  const expiresAt = Date.now() + 10 * 60 * 1000;
  await env.OAUTH_KV.put(`confirmation:${confirmationToken}`, JSON.stringify({ ...confirmation, expiresAt }), { expirationTtl: 600 });
  return { confirmationToken, expiresAt: new Date(expiresAt).toISOString() };
}

async function readConfirmation(env: Env, confirmationToken: string): Promise<Confirmation> {
  const confirmation = await env.OAUTH_KV.get(`confirmation:${confirmationToken}`, "json") as Confirmation | null;
  if (!confirmation || confirmation.expiresAt < Date.now()) throw new Error("Confirmation token is invalid or expired; prepare the change again");
  return confirmation;
}

async function consumeConfirmation(env: Env, confirmationToken: string): Promise<void> {
  await env.OAUTH_KV.delete(`confirmation:${confirmationToken}`);
}

async function audit(env: Env, event: JsonRecord): Promise<void> {
  const now = Date.now();
  const retention = Math.max(1, Math.min(365, Number(env.AUDIT_RETENTION_DAYS || 90)));
  await env.OAUTH_KV.put(`audit:${String(now).padStart(13, "0")}:${token().slice(0, 12)}`, JSON.stringify({ timestamp: new Date(now).toISOString(), actor: "admin-connector", ...event }), { expirationTtl: retention * 86400 });
}

function createdRecordId(response: JsonRecord): string {
  const result = Array.isArray(response.result) ? response.result[0] as JsonRecord | undefined : undefined;
  const data = result?.data as JsonRecord | undefined;
  const id = data?.ID;
  if (typeof id !== "string" || !/^\d+$/.test(id)) throw new Error("Zoho created the record but did not return a valid record ID");
  return id;
}

export function registerWriteTools(server: McpServer, env: Env): void {
  server.registerTool("prepare_create_record", { description: "Prepare and preview creation of one Zoho Creator record. This does not write anything. The returned token may be used only after the user explicitly confirms the exact preview.", inputSchema: { app_link_name: linkName, form_link_name: linkName, verification_report_link_name: linkName, data: recordData, environment }, annotations: readOnly }, async ({ app_link_name, form_link_name, verification_report_link_name, data, environment }) => {
    assertWriteTarget(env, app_link_name, "form", form_link_name);
    assertWriteTarget(env, app_link_name, "report", verification_report_link_name);
    validateData(data);
    await validateFormFields(env, app_link_name, form_link_name, data, environment);
    const target = `${environment}:${app_link_name}:form:${form_link_name}:verify:${verification_report_link_name}`;
    const prepared = await prepareConfirmation(env, { action: "create", target, payloadHash: await hash(data) });
    return output({ action: "create", target: { app_link_name, form_link_name, verification_report_link_name, environment }, proposed_data: data, confirmation_token: prepared.confirmationToken, expires_at: prepared.expiresAt, requires_explicit_user_confirmation: true });
  });

  server.registerTool("create_record", { description: "Create exactly one prepared Zoho Creator record. Call only after the user explicitly confirms the exact preview returned by prepare_create_record.", inputSchema: { app_link_name: linkName, form_link_name: linkName, verification_report_link_name: linkName, data: recordData, confirmation_token: z.string().min(20).max(200), confirmed: z.literal(true), environment }, annotations: createWrite }, async ({ app_link_name, form_link_name, verification_report_link_name, data, confirmation_token, environment }) => {
    assertWriteTarget(env, app_link_name, "form", form_link_name);
    assertWriteTarget(env, app_link_name, "report", verification_report_link_name);
    validateData(data);
    const target = `${environment}:${app_link_name}:form:${form_link_name}:verify:${verification_report_link_name}`;
    const confirmation = await readConfirmation(env, confirmation_token);
    if (confirmation.action !== "create" || confirmation.target !== target || confirmation.payloadHash !== await hash(data)) throw new Error("The confirmed create operation does not match the prepared preview");
    await consumeConfirmation(env, confirmation_token);

    const owner = safeLinkName(env.ZOHO_ACCOUNT_OWNER, "account owner");
    const result = await zohoMutate(env, `/creator/v2.1/data/${owner}/${app_link_name}/form/${form_link_name}`, "POST", { data, result: { fields: ["ID", ...Object.keys(data)], message: true } }, {}, environment);
    const id = createdRecordId(result);
    const after = subset(await getRecord(env, app_link_name, verification_report_link_name, id, environment), ["ID", ...Object.keys(data)]);
    const mismatches = mismatchedFields(after, data);
    await audit(env, { action: "create", app_link_name, form_link_name, report_link_name: verification_report_link_name, record_id: id, before: null, after, result: mismatches.length ? "verification_mismatch" : "verified", mismatched_fields: mismatches });
    if (mismatches.length) throw new Error(`Zoho created record ${id}, but read-back verification differed for: ${mismatches.join(", ")}. Do not retry automatically.`);
    return output({ code: 3000, action: "create", record_id: id, verified: true, record: after });
  });

  server.registerTool("prepare_update_record", { description: "Read one record and preview an exact field-level update. This does not write anything. The returned token may be used only after the user explicitly confirms the preview.", inputSchema: { app_link_name: linkName, form_link_name: linkName, report_link_name: linkName, record_id: recordId, data: recordData, environment }, annotations: readOnly }, async ({ app_link_name, form_link_name, report_link_name, record_id, data, environment }) => {
    assertWriteTarget(env, app_link_name, "form", form_link_name);
    assertWriteTarget(env, app_link_name, "report", report_link_name);
    validateData(data);
    await validateFormFields(env, app_link_name, form_link_name, data, environment);
    const before = subset(await getRecord(env, app_link_name, report_link_name, record_id, environment), Object.keys(data));
    const target = `${environment}:${app_link_name}:form:${form_link_name}:report:${report_link_name}:record:${record_id}`;
    const prepared = await prepareConfirmation(env, { action: "update", target, payloadHash: await hash(data), beforeHash: await hash(before) });
    const changes = Object.keys(data).map((field) => ({ field, from: before[field], to: data[field] }));
    if (changes.every((change) => containsExpected(change.from, change.to))) throw new Error("The record already contains all proposed values; no update is needed");
    return output({ action: "update", target: { app_link_name, form_link_name, report_link_name, record_id, environment }, changes, confirmation_token: prepared.confirmationToken, expires_at: prepared.expiresAt, requires_explicit_user_confirmation: true });
  });

  server.registerTool("update_record", { description: "Apply one prepared record update. Call only after the user explicitly confirms the exact preview returned by prepare_update_record. The operation aborts if the record changed after preparation.", inputSchema: { app_link_name: linkName, form_link_name: linkName, report_link_name: linkName, record_id: recordId, data: recordData, confirmation_token: z.string().min(20).max(200), confirmed: z.literal(true), environment }, annotations: updateWrite }, async ({ app_link_name, form_link_name, report_link_name, record_id, data, confirmation_token, environment }) => {
    assertWriteTarget(env, app_link_name, "form", form_link_name);
    assertWriteTarget(env, app_link_name, "report", report_link_name);
    validateData(data);
    const target = `${environment}:${app_link_name}:form:${form_link_name}:report:${report_link_name}:record:${record_id}`;
    const confirmation = await readConfirmation(env, confirmation_token);
    const before = subset(await getRecord(env, app_link_name, report_link_name, record_id, environment), Object.keys(data));
    if (confirmation.action !== "update" || confirmation.target !== target || confirmation.payloadHash !== await hash(data) || confirmation.beforeHash !== await hash(before)) {
      throw new Error("The record or proposed update no longer matches the prepared preview; prepare it again");
    }
    await consumeConfirmation(env, confirmation_token);

    const owner = safeLinkName(env.ZOHO_ACCOUNT_OWNER, "account owner");
    await zohoMutate(env, `/creator/v2.1/data/${owner}/${app_link_name}/report/${report_link_name}`, "PATCH", { criteria: `ID == ${record_id}`, data, result: { fields: ["ID", ...Object.keys(data)], message: true } }, {}, environment);
    const after = subset(await getRecord(env, app_link_name, report_link_name, record_id, environment), Object.keys(data));
    const mismatches = mismatchedFields(after, data);
    await audit(env, { action: "update", app_link_name, form_link_name, report_link_name, record_id, before, after, result: mismatches.length ? "verification_mismatch" : "verified", mismatched_fields: mismatches });
    if (mismatches.length) throw new Error(`Zoho updated record ${record_id}, but read-back verification differed for: ${mismatches.join(", ")}. Do not retry automatically.`);
    return output({ code: 3000, action: "update", record_id, verified: true, before, after });
  });

  server.registerTool("list_audit_events", { description: "List recent create/update audit events generated by the admin connector.", inputSchema: { limit: z.number().int().min(1).max(50).default(20) }, annotations: readOnly }, async ({ limit }) => {
    const keys = await env.OAUTH_KV.list({ prefix: "audit:", limit: 1000 });
    const selected = keys.keys.sort((a, b) => b.name.localeCompare(a.name)).slice(0, limit);
    const events = (await Promise.all(selected.map((key) => env.OAUTH_KV.get(key.name, "json")))).filter(Boolean);
    return output({ count: events.length, events });
  });
}
