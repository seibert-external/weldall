import type { JWK, JWTPayload } from "jose";
import type { SkillProvider } from "./skills.js";

export type DpopKeyPair = { privateJwk: JWK; publicJwk: JWK; jkt: string };
export type VerifiedDpop = {
  payload: JWTPayload & {
    htm: string;
    htu: string;
    jti: string;
    iat: number;
    ath?: string;
  };
  publicJwk: JWK;
  jkt: string;
};
export type JwtKey = { kid: string; privateJwk: JWK; publicJwk: JWK };
export type IdJagClaims = JWTPayload & {
  iss: string;
  sub: string;
  email: string;
  email_verified: true;
  aud: string;
  client_id: string;
  resource: string;
  scope: string;
  cnf: { jkt: string };
  jti: string;
  iat: number;
  exp: number;
};

export interface ReplayStore {
  /** Atomically consumes a key. true is the first use; false is a replay. */
  consume(key: string, expiresAt: Date): Promise<boolean>;
}

export type DirectSigningKey = { kid: string; privateJwk: JWK; publicJwk: JWK };
export interface ProviderSigningKey {
  kid: string;
  publicJwk: JWK;
  sign(
    payload: JWTPayload,
    protectedHeader: { alg: "ES256"; kid: string; typ: string },
  ): Promise<string>;
}
export interface SigningKeyProvider {
  current(): Promise<ProviderSigningKey>;
  jwks(): Promise<readonly JWK[]>;
}
export type Signing = DirectSigningKey | SigningKeyProvider;

export type ScopePolicy = {
  /** Every listed scope is required. */
  scopes?: readonly string[];
  /** In addition, at least one listed scope is required. */
  anyScopes?: readonly string[];
};

export type AuthIdentity = {
  subject: string;
  email: string;
  emailVerified: true;
};
export type AuthContext = {
  identity: AuthIdentity;
  subject: string;
  email: string;
  emailVerified: true;
  scopes: readonly string[];
  tokenId: string;
  clientId: string;
};

export type WorkloadIdentity = {
  type: "workload";
  subject: string;
  clientId: string;
};
export type WorkloadAuthContext = {
  identity: WorkloadIdentity;
  identityType: "workload";
  subject: string;
  clientId: string;
  scopes: readonly string[];
  tokenId: string;
};

export type WorkloadVerifierOptions = {
  resource: string;
  publicOrigin: string;
  supportedScopes: readonly string[];
  /** Target-local allowlist; a valid token alone never selects a trusted caller. */
  allowedClientIds: readonly string[];
  replayStore: ReplayStore;
  discoveryTimeoutMs?: number;
};

export type VerifyResult =
  | { ok: true; auth: AuthContext }
  | {
      ok: false;
      error: import("./errors.js").WeldallAuthError;
      response: Response;
    };

export type WeldallOptions = {
  resource: string;
  publicOrigin: string;
  clientId: string;
  supportedScopes: readonly string[];
  signingKey: Signing;
  replayStore: ReplayStore | "disabled";
  discoveryTimeoutMs?: number;
  allowInsecureLoopback?: boolean;
  skills?: SkillProvider;
};
