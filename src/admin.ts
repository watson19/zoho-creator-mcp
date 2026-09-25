export { ZohoTokenBroker } from "./token-broker";
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { apiHandler, defaultHandler } from "./index";
import type { Env } from "./zoho";

const base = "https://zoho-creator-admin-mcp.ec4c5111f2c81375a3b2ae75ae7d3c37ceca2fa0.workers.dev";

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
    resource_name: "Zoho Creator Admin MCP"
  },
  clientIdMetadataDocumentEnabled: false,
  accessTokenTTL: 60 * 60,
  refreshTokenTTL: 30 * 24 * 60 * 60
});
