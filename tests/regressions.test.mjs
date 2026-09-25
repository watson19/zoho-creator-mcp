import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve, basename } from 'node:path';

async function loadSource(path) {
  const result = await build({ entryPoints: [path], bundle: true, platform: 'node', format: 'esm', write: false });
  await mkdir('dist/tests', { recursive: true });
  const output = resolve('dist/tests', basename(path, '.ts') + '.mjs');
  await writeFile(output, result.outputFiles[0].text);
  return import(pathToFileURL(output).href);
}
const { TokenCoordinator, credentialKey } = await loadSource('src/token-cache.ts');
const { registerWriteTools } = await loadSource('src/writes.ts');
const credentials = { accountsUrl: 'https://accounts.zoho.com', clientId: 'test-client', clientSecret: 'test-secret', refreshToken: 'test-refresh' };
const storage = () => {
  const values = new Map();
  return { values, async get(key, format) { const value = structuredClone(values.get(key)); return format === "json" && typeof value === "string" ? JSON.parse(value) : value; }, async put(key, value) { values.set(key, structuredClone(value)); }, async delete(key) { values.delete(key); } };
};
const tokenResponse = token => Response.json({ access_token: token, api_domain: 'https://www.zohoapis.com', expires_in: 3600 });

test('50 simultaneous callers share one refresh; persisted token survives runtime replacement', async () => {
  let refreshes = 0;
  const persistent = storage();
  const fetcher = async () => { refreshes++; await new Promise(r => setTimeout(r, 10)); return tokenResponse('token-1'); };
  const broker = new TokenCoordinator(persistent, fetcher);
  const results = await Promise.all(Array.from({ length: 50 }, () => broker.get(credentials)));
  assert.equal(refreshes, 1);
  assert.ok(results.every(r => r.accessToken === 'token-1'));
  for (let i = 0; i < 12; i++) {
    const restarted = new TokenCoordinator(persistent, fetcher);
    assert.equal((await restarted.get(credentials)).accessToken, 'token-1');
  }
  assert.equal(refreshes, 1);
  const saved = JSON.stringify([...persistent.values]);
  assert.ok(!saved.includes(credentials.clientSecret) && !saved.includes(credentials.refreshToken));
});

test('expired tokens refresh once, and simultaneous 401 retries do not discard a fresh token', async () => {
  let now = 1_000_000, refreshes = 0;
  const broker = new TokenCoordinator(storage(), async () => { refreshes++; await new Promise(r => setTimeout(r, 5)); return tokenResponse(`token-${refreshes}`); }, () => now);
  await broker.get(credentials);
  await Promise.all(Array.from({ length: 20 }, () => broker.get({ ...credentials, rejectedAccessToken: 'token-1' })));
  assert.equal(refreshes, 2);
  assert.equal((await broker.get({ ...credentials, rejectedAccessToken: 'token-1' })).accessToken, 'token-2');
  assert.equal(refreshes, 2);
  now += 3600_000;
  await Promise.all(Array.from({ length: 20 }, () => broker.get(credentials)));
  assert.equal(refreshes, 3);
});

test('refresh errors retain the explanation, redact credentials, and persist a cooldown', async () => {
  let now = 1_000_000, refreshes = 0;
  const persistent = storage();
  const fetcher = async () => { refreshes++; return Response.json({ error: 'Access Denied', error_description: `Too many requests ${credentials.clientSecret} ${credentials.refreshToken}` }, { status: 400 }); };
  const broker = new TokenCoordinator(persistent, fetcher, () => now);
  const failures = await Promise.allSettled(Array.from({ length: 20 }, () => broker.get(credentials)));
  assert.equal(refreshes, 1);
  for (const result of failures) {
    assert.equal(result.status, 'rejected');
    assert.match(result.reason.message, /Too many requests/);
    assert.ok(!result.reason.message.includes(credentials.clientSecret));
    assert.ok(!result.reason.message.includes(credentials.refreshToken));
  }
  const restarted = new TokenCoordinator(persistent, fetcher, () => now);
  await assert.rejects(restarted.get(credentials), /retry after 600 seconds/);
  assert.equal(refreshes, 1);
  now += 600_001;
  await assert.rejects(restarted.get(credentials), /Too many requests/);
  assert.equal(refreshes, 2);
});

test('credential rotation and different read/admin credentials get separate cache identities', async () => {
  const base = await credentialKey(credentials);
  assert.equal(base, await credentialKey({ ...credentials }));
  for (const key of ['clientId', 'clientSecret', 'refreshToken']) assert.notEqual(base, await credentialKey({ ...credentials, [key]: 'changed-value' }));
  await assert.rejects(credentialKey({ ...credentials, accountsUrl: 'https://attacker.example' }), /approved Zoho/);
});

function fixture(t, { initial = '', omit = false, hideAfterWrite = false, rejectFirstApi = false } = {}) {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const kv = storage(), tokenStore = storage();
  const calls = { patches: 0, tokenRefreshes: 0, reads: 0, queries: [] };
  let value = initial, reject = rejectFirstApi;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input);
    if (url.pathname === '/oauth/v2/token') { calls.tokenRefreshes++; return tokenResponse(`test-access-${calls.tokenRefreshes}`); }
    if (reject) { reject = false; return Response.json({}, { status: 401 }); }
    if (url.pathname.endsWith('/fields')) return Response.json({ code: 3000, fields: [{ link_name: 'Hermanos' }] });
    if (init.method === 'PATCH') { calls.patches++; value = JSON.parse(init.body).data.Hermanos; return Response.json({ code: 3000 }); }
    calls.reads++;
    calls.queries.push(Object.fromEntries(url.searchParams));
    const data = { ID: '123', ...(omit || hideAfterWrite && calls.patches ? {} : { Hermanos: value }) };
    return Response.json({ code: 3000, data });
  };
  const broker = new TokenCoordinator(tokenStore, (...args) => globalThis.fetch(...args));
  const env = {
    ZOHO_CLIENT_ID: credentials.clientId, ZOHO_CLIENT_SECRET: credentials.clientSecret, ZOHO_REFRESH_TOKEN: credentials.refreshToken,
    ZOHO_ACCOUNT_OWNER: 'idiomaswatson', ACCESS_MODE: 'read_write', WRITE_ALLOWED_APPS: 'estudiantes',
    WRITE_ALLOWED_FORMS: 'estudiantes/Informacion', WRITE_ALLOWED_REPORTS: 'estudiantes/All_Students', OAUTH_KV: kv,
    ZOHO_TOKEN_BROKER: { idFromName: key => key, get: () => ({ fetch: async (_url, init) => Response.json(await broker.get(JSON.parse(init.body))) }) }
  };
  const handlers = new Map();
  registerWriteTools({ registerTool: (name, _schema, fn) => handlers.set(name, fn) }, env);
  const args = { app_link_name: 'estudiantes', form_link_name: 'Informacion', report_link_name: 'All_Students', record_id: '123', environment: 'production', data: { Hermanos: 'H' } };
  return { calls, kv, args, setValue: next => { value = next; }, run: (name, extra = {}) => handlers.get(name)({ ...args, ...extra }) };
}

test('Hermanos is explicitly requested; existing (H) previews correctly and updates verify', async t => {
  const f = fixture(t, { initial: '(H)', rejectFirstApi: true });
  const preview = (await f.run('prepare_update_record')).structuredContent;
  assert.deepEqual(preview.changes, [{ field: 'Hermanos', from: '(H)', to: 'H' }]);
  const result = (await f.run('update_record', { confirmed: true, confirmation_token: preview.confirmation_token })).structuredContent;
  assert.equal(result.verified, true);
  assert.equal(result.after.Hermanos, 'H');
  assert.equal(f.calls.patches, 1);
  assert.equal(f.calls.tokenRefreshes, 2);
  assert.ok(f.calls.queries.every(query => query.field_config === 'custom' && query.fields === 'ID,Hermanos'));
});

test('missing fields fail before confirmation or mutation; explicit blank remains valid', async t => {
  const f = fixture(t, { omit: true });
  await assert.rejects(f.run('prepare_update_record'), /fields missing.*Hermanos/);
  assert.equal(f.kv.values.size, 0);
  assert.equal(f.calls.patches, 0);
});

test('blank values are not confused with missing fields', async t => {
  const f = fixture(t);
  const preview = (await f.run('prepare_update_record')).structuredContent;
  assert.equal(preview.changes[0].from, '');
});

test('a field changed after preview aborts without mutation', async t => {
  const f = fixture(t);
  const preview = (await f.run('prepare_update_record')).structuredContent;
  f.setValue('Changed by someone else');
  await assert.rejects(f.run('update_record', { confirmed: true, confirmation_token: preview.confirmation_token }), /no longer matches/);
  assert.equal(f.calls.patches, 0);
});

test('unavailable verification after a write explicitly reports the completed write and prevents blind retry', async t => {
  const f = fixture(t, { hideAfterWrite: true });
  const preview = (await f.run('prepare_update_record')).structuredContent;
  await assert.rejects(f.run('update_record', { confirmed: true, confirmation_token: preview.confirmation_token }), /Zoho updated record 123.*Do not retry automatically/);
  assert.equal(f.calls.patches, 1);
  assert.ok([...f.kv.values.values()].some(v => typeof v === 'string' && v.includes('verification_unavailable')));
  await assert.rejects(f.run('update_record', { confirmed: true, confirmation_token: preview.confirmation_token }), /invalid or expired/);
  assert.equal(f.calls.patches, 1);
});

test('write allowlists stay enforced', async t => {
  const f = fixture(t);
  await assert.rejects(f.run('prepare_update_record', { report_link_name: 'All_Data' }), /Write access is not allowed/);
  assert.equal(f.calls.reads, 0);
  assert.equal(f.calls.patches, 0);
});
