# Zoho Creator MCP

A Cloudflare Worker that gives ChatGPT OAuth-protected, read-only access to Zoho Creator.

## Safety boundary

The MCP server contains no create, update, or delete tools. It exposes only:

- `list_applications`
- `list_components` for forms, reports, pages, and sections
- `get_form_fields`
- `get_records` (maximum 200 rows per call)
- `get_record`

Every tool is annotated read-only. Zoho link names are validated, arbitrary URLs are rejected, and `/mcp` fails closed unless the request carries a valid OAuth access token.

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

Add the server in ChatGPT developer mode using:

```text
https://<worker-host>/mcp
```

Choose **OAuth**. ChatGPT discovers the remaining endpoints automatically.

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

The Zoho token is authorised for possible future read/write work, but this MCP release intentionally registers read-only tools only. Adding mutation tools requires a separate reviewed change with confirmation and audit safeguards.

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
npm run dev
npm run deploy
```

Never commit `.dev.vars`, OAuth tokens, Zoho credentials, or the shared secret.
