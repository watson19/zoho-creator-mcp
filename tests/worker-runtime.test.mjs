import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions, Response as WorkerResponse } from 'miniflare';

// Run the actual Durable Object adapter and API client in Cloudflare's local
// runtime, with separate caller Workers and fully mocked outbound Zoho traffic.
test('separate Worker callers share one persisted token coordinator', async () => {
  const bundle = await build({ stdin: { contents: `
    export { ZohoTokenBroker } from './src/token-broker';
    import { zohoGet } from './src/zoho';
    export default { async fetch(request, env) {
      return Response.json(await zohoGet(env, '/creator/v2.1/meta/applications'));
    }};
  `, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, format: 'esm', platform: 'neutral', external: ['cloudflare:workers'], write: false });
  let refreshes = 0;
  const outboundService = async request => {
    const url = new URL(request.url);
    if (url.pathname === '/oauth/v2/token') {
      refreshes++;
      return WorkerResponse.json({ access_token: 'mock-runtime-token', api_domain: 'https://www.zohoapis.com', expires_in: 3600 });
    }
    assert.equal(request.headers.get('Authorization'), 'Zoho-oauthtoken mock-runtime-token');
    return WorkerResponse.json({ code: 3000, data: [] });
  };
  const common = { modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-09-19', outboundService,
    bindings: { ZOHO_CLIENT_ID: 'dummy-client', ZOHO_CLIENT_SECRET: 'dummy-secret', ZOHO_REFRESH_TOKEN: 'dummy-refresh', ZOHO_ACCOUNT_OWNER: 'dummy-owner' } };
  const mf = new Miniflare(convertV4MiniflareOptions({ workers: [
    { ...common, name: 'broker-host', durableObjects: { ZOHO_TOKEN_BROKER: { className: 'ZohoTokenBroker', useSQLite: true } } },
    { ...common, name: 'reader', durableObjects: { ZOHO_TOKEN_BROKER: { className: 'ZohoTokenBroker', scriptName: 'broker-host', useSQLite: true } } }
  ] }));
  try {
    const [admin, reader] = await Promise.all([mf.getWorker('broker-host'), mf.getWorker('reader')]);
    const results = await Promise.all(Array.from({ length: 30 }, (_, i) => (i % 2 ? admin : reader).fetch('https://test/')));
    assert.ok(results.every(response => response.status === 200));
    assert.equal(refreshes, 1);
    await Promise.all(results.map(response => response.arrayBuffer()));
  } finally { await mf.dispose(); }
});
