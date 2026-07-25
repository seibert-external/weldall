import { decodeProtectedHeader, importJWK, type JWK } from "jose";
import { assertPublicP256 } from "./crypto.js";
import { WeldallAuthError } from "./errors.js";

export type DiscoveryMetadata = { issuer: string; jwks_uri: string };

const jsonResponse = async (response: Response): Promise<unknown> => {
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json" && contentType !== "application/jwk-set+json")
    throw new Error("unexpected content type");
  const text = await response.text();
  if (text.length > 256_000) throw new Error("response too large");
  return JSON.parse(text);
};

const JWKS_TTL_MS = 60_000;

export class WeldallDiscovery {
  private metadata?: DiscoveryMetadata;
  private keys = new Map<string, JWK>();
  private metadataPromise: Promise<DiscoveryMetadata> | undefined;
  private jwksPromise: Promise<void> | undefined;
  private jwksExpiresAt = 0;
  private unknownRefreshAt = 0;

  constructor(
    private readonly host: string,
    private readonly timeoutMs: number,
  ) {}

  async ready(): Promise<void> {
    await this.refreshJwks(false);
  }

  async getKey(
    token: string,
    refreshForValidationFailure = false,
  ): Promise<{ kid: string; jwk: JWK }> {
    let kid: unknown;
    try {
      const header = decodeProtectedHeader(token);
      if (header.alg !== "ES256" || header.typ !== "oauth-id-jag+jwt" || header.crit)
        throw new Error("header");
      kid = header.kid;
    } catch {
      throw new WeldallAuthError("invalid_grant", "invalid ID-JAG header");
    }
    if (typeof kid !== "string" || !kid)
      throw new WeldallAuthError("invalid_grant", "invalid ID-JAG header");
    await this.refreshJwks(false);
    let jwk = this.keys.get(kid);
    if ((refreshForValidationFailure || !jwk) && Date.now() >= this.unknownRefreshAt) {
      this.unknownRefreshAt = Date.now() + 5_000;
      await this.refreshJwks(true);
      jwk = this.keys.get(kid);
    }
    if (!jwk) throw new WeldallAuthError("invalid_grant", "unknown Weldall signing key");
    return { kid, jwk };
  }

  private async discover(): Promise<DiscoveryMetadata> {
    if (this.metadata) return this.metadata;
    if (this.metadataPromise) return this.metadataPromise;
    this.metadataPromise = this.fetchMetadata().finally(() => {
      this.metadataPromise = undefined;
    });
    return this.metadataPromise;
  }

  private async fetchMetadata(): Promise<DiscoveryMetadata> {
    try {
      const value = await this.fetchJson(`${this.host}/.well-known/oauth-authorization-server`);
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("invalid metadata");
      const { issuer, jwks_uri: jwksUri } = value as Record<string, unknown>;
      if (issuer !== this.host || typeof jwksUri !== "string") throw new Error("issuer mismatch");
      const url = new URL(jwksUri);
      if (url.origin !== this.host || url.username || url.password || url.search || url.hash)
        throw new Error("unsafe jwks_uri");
      this.metadata = { issuer, jwks_uri: url.toString() };
      return this.metadata;
    } catch {
      throw new WeldallAuthError("temporarily_unavailable", "Weldall discovery failed", 503);
    }
  }

  private async refreshJwks(force: boolean): Promise<void> {
    if (this.jwksPromise) return this.jwksPromise;
    if (!force && this.keys.size && Date.now() < this.jwksExpiresAt) return;
    this.jwksPromise = (async () => {
      const metadata = await this.discover();
      try {
        const value = await this.fetchJson(metadata.jwks_uri);
        if (!value || typeof value !== "object" || Array.isArray(value))
          throw new Error("invalid JWKS");
        const keys = (value as { keys?: unknown }).keys;
        if (!Array.isArray(keys) || keys.length < 1 || keys.length > 20)
          throw new Error("invalid JWKS size");
        const next = new Map<string, JWK>();
        for (const candidate of keys) {
          if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
            throw new Error("invalid JWK");
          const jwk = candidate as JWK;
          if (typeof jwk.kid !== "string" || !jwk.kid || next.has(jwk.kid))
            throw new Error("invalid JWK kid");
          await assertPublicP256(jwk);
          await importJWK(jwk, "ES256");
          next.set(jwk.kid, jwk);
        }
        this.keys = next;
        this.jwksExpiresAt = Date.now() + JWKS_TTL_MS;
      } catch (error) {
        if (error instanceof WeldallAuthError) throw error;
        throw new WeldallAuthError("temporarily_unavailable", "Weldall JWKS fetch failed", 503);
      }
    })().finally(() => {
      this.jwksPromise = undefined;
    });
    return this.jwksPromise;
  }

  private async fetchJson(url: string): Promise<unknown> {
    const signal = AbortSignal.timeout(this.timeoutMs);
    return jsonResponse(
      await fetch(url, { redirect: "error", signal, headers: { accept: "application/json" } }),
    );
  }
}
