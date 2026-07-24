import type { JWK, JWTPayload } from "jose";
export type ResourceGrant = {
  name: string;
  authorizationServer: string;
  resource: string;
  downstreamClientId: string;
  scopes: string[];
};
export type DpopKeyPair = { privateJwk: JWK; publicJwk: JWK; jkt: string };
export type VerifiedDpop = {
  payload: JWTPayload & { htm: string; htu: string; jti: string; iat: number; ath?: string };
  publicJwk: JWK;
  jkt: string;
};
export type JwtKey = { kid: string; privateJwk: JWK; publicJwk: JWK };
export type IdJagClaims = JWTPayload & {
  iss: string;
  sub: string;
  aud: string;
  client_id: string;
  resource: string;
  scope: string;
  cnf: { jkt: string };
  jti: string;
  iat: number;
  exp: number;
};
