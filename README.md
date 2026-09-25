# Zoho Creator MCP

A Cloudflare Worker project that deploys two separately authorised ChatGPT connectors for Zoho Creator:

- `zoho-creator-mcp` — read-only, intended for delegated users
- `zoho-creator-admin-mcp` — read/write, intended only for the owner

## Safety boundary

The read-only Worker exposes only:

- `list_applications`
- `list_components` for forms, reports, pages, and sections
- `get_form_fields`
- `get_records` (cursor-based pages of 200, 500, or 1,000 rows)
- `count_records` (follows every cursor while fetching IDs only)
- `get_all_records` (follows cursors for a required, limited field selection)
- `get_record`
- `get_record_file`

Every tool is annotated read-only. Zoho link names are validated, arbitrary URLs are rejected, and `/mcp` fails closed unless the request carries a valid OAuth access token.

The separate admin Worker adds:

- `prepare_create_record` and `create_record`
- `prepare_update_record` and `update_record`
- `list_audit_events`

The admin Worker deliberately has no delete or bulk-update tool. Writes are denied unless `ACCESS_MODE=read_write`; targets must be present in the server-side allowlists. Every mutation requires a short-lived confirmation token generated from an exact preview, updates abort if the record changed after preparation, successful writes are read back for verification, and audit events are retained for 90 days by default.

## ChatGPT authentication

The Worker implements a private OAuth 2.1 authorization-code flow with:

- OAuth authorization-server metadata
- OAuth protected-resource metadata
- dynamic client registration
- PKCE using `S256`
- short-lived, signed authorization codes
- signed 30-day access tokens
- exact redirect-URI and audience validation

The OAuth approval page asks the owner for `MCP_SHARED_SECRET`. The secret is never sent to ChatGPT. It stays in the browser-to-Worker authorization request and is also used by the Worker to sign tokens. Changing `MCP_SHARED_SECRET` immediately invalidates all existing OAuth clients, codes, and access tokens.

Add the read-only server in ChatGPT developer mode using:

```text
https://<worker-host>/mcp
```

Choose **OAuth**. ChatGPT discovers the remaining endpoints automatically.

The admin connector uses its own Worker URL and a different `MCP_SHARED_SECRET`. Never give the admin URL or secret to a read-only user.

## Zoho OAuth setup

The current Zoho refresh token may include these Creator and Forms scopes:

```text
ZohoCreator.dashboard.READ
ZohoCreator.meta.application.READ
ZohoCreator.meta.form.READ
ZohoCreator.report.READ
ZohoCreator.form.CREATE
ZohoCreator.report.UPDATE
ZohoCreator.report.DELETE
ZohoForms.forms.ALL
```

The read-only Worker registers read tools only. The admin Worker registers the confirmed create/update tools described above; its allowlists and confirmation checks remain mandatory.

## Cloudflare runtime configuration

| Name | Store as | Notes |
|---|---|---|
| `MCP_SHARED_SECRET` | encrypted secret | Long random value; OAuth approval and signing key |
| `ZOHO_CLIENT_ID` | encrypted secret | Existing Zoho client ID |
| `ZOHO_CLIENT_SECRET` | encrypted secret | Existing Zoho client secret |
| `ZOHO_REFRESH_TOKEN` | encrypted secret | Zoho refresh token with the required scopes |
| `ZOHO_ACCOUNT_OWNER` | variable | `idiomaswatson` |
| `ZOHO_ACCOUNTS_URL` | variable | `https://accounts.zoho.com` |
| `ZOHO_API_DOMAIN` | variable | `https://www.zohoapis.com` fallback |

Admin-only variables:

| Name | Example | Purpose |
|---|---|---|
| `ACCESS_MODE` | `read_write` | Enables registration and execution of mutation tools |
| `WRITE_ALLOWED_APPS` | `estudiantes` | Comma-separated app allowlist |
| `WRITE_ALLOWED_FORMS` | `estudiantes/Informacion` | Comma-separated create/update form allowlist |
| `WRITE_ALLOWED_REPORTS` | `estudiantes/All_Students` | Comma-separated verification/update report allowlist |
| `AUDIT_RETENTION_DAYS` | `90` | Audit-event retention, clamped to 1–365 days |

The older name `ZOHO_ACCOUNTS_DOMAIN` remains supported.

## Endpoints

- `/mcp` — OAuth-protected streamable HTTP MCP endpoint
- `/health` — non-sensitive service status
- `/.well-known/oauth-protected-resource` — protected-resource metadata
- `/.well-known/oauth-protected-resource/mcp` — path-specific protected-resource metadata
- `/.well-known/oauth-authorization-server` — authorization-server metadata
- `/register` — dynamic client registration
- `/authorize` — owner authorization screen
- `/token` — PKCE authorization-code exchange

## Commands

```bash
npm install
npm run typecheck
npm test
npm run dev
npm run deploy
npm run deploy:admin
```

The two Workers must be configured with different `MCP_SHARED_SECRET` values. For strongest least privilege, also give the read-only Worker a Zoho refresh token containing only read scopes and give the admin Worker the read/write token.

Never commit `.dev.vars`, OAuth tokens, Zoho credentials, or the shared secret.

## Token coordination (v0.5.1)

Zoho access tokens are cached in the SQLite-backed `ZohoTokenBroker` Durable
Object hosted by the admin Worker. Both Workers bind to this coordinator. The
object identity is a SHA-256 fingerprint of the Zoho OAuth credentials and account
host, so different credentials remain isolated and credential rotation selects a
new object. Client secrets and refresh tokens are sent only over the internal
binding and are not persisted; the access token and expiry are persisted.

Refreshes are coalesced into one in-flight request. A 401 invalidates only the
access token that actually failed, so a concurrent request cannot invalidate its
replacement. Token endpoint throttling persists a ten-minute cooldown. Error
messages retain Zoho's explanation with credentials redacted.

Deploy the admin Worker first (this creates the Durable Object), then the reader:

```bash
npm run deploy:admin
npm run deploy
```

The GitHub deployment workflow performs that order after tests and type checks.
Do not remove the broker binding from either Worker. Existing OAuth secrets,
write allowlists, explicit preview confirmation, and audit behavior are preserved.

## Required fields for write verification

The write tools request `field_config=custom` and the exact fields being changed.
If a field is absent from the authorised report response, preparation fails;
missing fields are never interpreted as blank. Make fields such as `Hermanos`
readable in the existing authorised report if Zoho still omits them. The connector
does not switch reports or broaden write access to bypass this check.

If a write succeeds but subsequent read-back is unavailable, the error explicitly
states that the write occurred and must not be retried automatically.
