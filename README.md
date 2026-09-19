# Zoho Creator MCP

A Cloudflare Worker that gives an MCP client strictly read-only access to Zoho Creator.

## Safety boundary

This server contains no create, update, or delete tools. It exposes only:

- `list_applications`
- `list_components` for forms, reports, pages, and sections
- `get_form_fields`
- `get_records` (maximum 200 rows per call)
- `get_record`

Every tool is annotated read-only. Zoho link names are validated, arbitrary URLs are rejected, and the server fails closed unless `MCP_SHARED_SECRET` is configured.

## Zoho OAuth setup

Create a Zoho API client and obtain a refresh token with only these scopes:

```
ZohoCreator.dashboard.READ
ZohoCreator.meta.application.READ
ZohoCreator.meta.form.READ
ZohoCreator.report.READ
```

Use the `.com` accounts domain for this account. The server then uses the `api_domain` Zoho returns, so the Creator data endpoint is never guessed or hard-coded.

Required Worker secrets:

```
MCP_SHARED_SECRET
ZOHO_CLIENT_ID
ZOHO_CLIENT_SECRET
ZOHO_REFRESH_TOKEN
ZOHO_ACCOUNT_OWNER
```

Optional variable (defaults to `https://accounts.zoho.com`):

```
ZOHO_ACCOUNTS_DOMAIN
```

Set `ZOHO_ACCOUNT_OWNER` to `idiomaswatson`.

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars
npm run dev
```

The MCP endpoint is `/mcp`; `/health` returns only a non-sensitive status response. Send `Authorization: Bearer <MCP_SHARED_SECRET>` for all MCP requests.

## Cloudflare deployment

Connect this repository in **Workers & Pages → Create → Import a repository**, then add the five required values as encrypted Worker secrets. Set the production branch to `main`. Cloudflare can then redeploy automatically after reviewed changes are merged.

Before adding the server to ChatGPT, replace the development shared-secret gate with an OAuth-compatible Cloudflare Access/OAuth flow. Do not expose the Worker without an authentication layer.

## Commands

```bash
npm run typecheck
npm run deploy
```

Never commit `.dev.vars`, OAuth tokens, or client secrets.
