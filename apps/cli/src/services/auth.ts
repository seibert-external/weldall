import { execFile } from "node:child_process";
import { createDpopProof, WELDALL_CLIENT_ID } from "@weldall/oauth";
import type { WeldallConfig } from "../config.js";
import { CliError } from "../errors.js";
import { isRecord, successfulResponse } from "../http.js";
import { loopback } from "../oauth/loopback.js";
import {
  createPkce,
  generateEs256KeyPair,
  randomValue,
  refresh,
  tokenRequest,
  validateLoginResponse,
} from "../oauth/session.js";
import { keychain, type StoredCredentials } from "../storage/keychain.js";
import { withLock } from "../storage/lock.js";

const openBrowser = (url: string) =>
  new Promise<void>((resolve, reject) => {
    execFile("open", [url], (error) => (error ? reject(error) : resolve()));
  });

const saveCredentials = async (issuer: string, credentials: StoredCredentials) =>
  keychain.set(issuer, {
    privateJwk: credentials.privateJwk,
    publicJwk: credentials.publicJwk,
    refreshToken: credentials.refreshToken,
  });

export async function login(config: WeldallConfig) {
  return withLock(async () => {
    const key = await generateEs256KeyPair();
    const state = randomValue();
    const nonce = randomValue();
    const pkce = createPkce();
    const callback = await loopback(state, config.issuer);
    const authorize = new URL(config.authorize);
    for (const [name, value] of Object.entries({
      response_type: "code",
      client_id: WELDALL_CLIENT_ID,
      redirect_uri: callback.redirectUri,
      scope: "openid profile email offline_access weldall:scopes",
      state,
      nonce,
      code_challenge: pkce.challenge,
      code_challenge_method: "S256",
      resource: config.resource,
      dpop_jkt: key.jkt,
    }))
      authorize.searchParams.set(name, value);

    try {
      await openBrowser(authorize.toString());
    } catch (error) {
      callback.close(new Error("unable to open the login page"));
      await callback.code.catch(() => undefined);
      throw new CliError("Unable to open the Weldall login page", { cause: error });
    }

    const code = await callback.code;
    const result = await tokenRequest(
      config,
      new URLSearchParams({
        grant_type: "authorization_code",
        client_id: WELDALL_CLIENT_ID,
        code,
        redirect_uri: callback.redirectUri,
        code_verifier: pkce.verifier,
      }),
      key,
    );
    const validated = await validateLoginResponse(config, result, key, nonce);
    await keychain.set(config.issuer, { ...key, refreshToken: validated.refreshToken });
    return validated.subject;
  });
}

export interface AccessSession {
  accessToken: string;
  credentials: StoredCredentials;
  subject: string;
}

export async function withAccess<T>(
  config: WeldallConfig,
  operation: (session: AccessSession) => Promise<T>,
): Promise<T> {
  const credentials = await keychain.get(config.issuer);
  if (!credentials)
    throw new CliError(`You are not logged in to ${config.issuer}`, {
      hint: "Run `weldall login` first.",
    });
  const fresh = await refresh(config, credentials);
  await saveCredentials(config.issuer, fresh.credentials);
  return operation(fresh);
}

export async function whoAmI(config: WeldallConfig) {
  return withLock(() =>
    withAccess(config, async (session) => {
      const proof = await createDpopProof({
        ...session.credentials,
        method: "GET",
        url: config.userInfo,
        accessToken: session.accessToken,
      });
      const value = await successfulResponse(
        await fetch(config.userInfo, {
          headers: {
            accept: "application/json",
            authorization: `DPoP ${session.accessToken}`,
            dpop: proof,
          },
          redirect: "error",
        }),
        "Weldall userinfo request",
      );
      if (!isRecord(value) || typeof value.sub !== "string" || value.sub !== session.subject)
        throw new CliError("Weldall returned inconsistent identity information");
      const name = typeof value.name === "string" ? value.name.trim() : "";
      const email = typeof value.email === "string" ? value.email.trim() : "";
      if (!name || !email || value.email_verified !== true)
        throw new CliError("Weldall did not return your verified profile", {
          hint: "Run `weldall logout`, then `weldall login` to refresh your account details.",
        });
      return { issuer: config.issuer, subject: value.sub, name, email };
    }),
  );
}

export async function logout(config: WeldallConfig) {
  return withLock(async () => {
    const credentials = await keychain.get(config.issuer);
    try {
      if (credentials) {
        const proof = await createDpopProof({
          ...credentials,
          method: "POST",
          url: config.revoke,
        });
        const response = await fetch(config.revoke, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", dpop: proof },
          body: new URLSearchParams({
            token: credentials.refreshToken,
            token_type_hint: "refresh_token",
            client_id: WELDALL_CLIENT_ID,
          }),
          redirect: "error",
        });
        if (!response.ok) throw new CliError(`Remote logout failed with HTTP ${response.status}`);
      }
    } finally {
      await keychain.clear(config.issuer);
    }
    return credentials !== null;
  });
}
