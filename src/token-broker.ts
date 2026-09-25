import { DurableObject } from "cloudflare:workers";
import { TokenCoordinator, credentialKey, type TokenRequest } from "./token-cache";

// Accessible through a Worker binding only; no public route exposes this class.
export class ZohoTokenBroker extends DurableObject {
  private coordinator = new TokenCoordinator(this.ctx.storage);

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
    try {
      const input = await request.json() as TokenRequest;
      const key = await credentialKey(input);
      if (new URL(request.url).pathname !== `/${key}`) throw new Error("Invalid token coordinator identity");
      // Bind the stored state to exactly one credential set, including after eviction.
      const storedKey = await this.ctx.storage.get<string>("credential-key");
      if (storedKey && storedKey !== key) throw new Error("Token coordinator credential mismatch");
      if (!storedKey) await this.ctx.storage.put("credential-key", key);
      return Response.json(await this.coordinator.get(input), { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : "Token coordinator failed" }, { status: 503, headers: { "Cache-Control": "no-store" } });
    }
  }
}
