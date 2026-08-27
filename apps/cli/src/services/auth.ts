import { createDpopProof } from "@weldall/sdk";
import { WELDALL_CLIENT_ID } from "../oauth/constants.js";
import { CONFIG_REFRESH_HINT, type WeldallConfig } from "../config.js";
import { CliError } from "../errors.js";
import { isRecord, successfulResponse } from "../http.js";
import { loopback } from "../oauth/loopback.js";
import {
  createPkce,
  generateEs256KeyPair,
  randomValue,
  tokenRequest,
  validateLoginResponse,
} from "../oauth/session.js";
import {
  keychain,
  type StoredCredentials,
  type StoredCredentialsInput,
} from "../storage/keychain.js";
import { withCredentialLock } from "../storage/lock.js";
import { SessionManager, type AccessSession } from "./session-manager.js";
import { browserOpener, type BrowserOpener } from "./browser.js";

const storedInput = (credentials: StoredCredentials): StoredCredentialsInput => ({
  privateJwk: credentials.privateJwk,
  publicJwk: credentials.publicJwk,
  refreshToken: credentials.refreshToken,
  ...(credentials.identity === undefined ? {} : { identity: credentials.identity }),
  ...(credentials.version === 2 && credentials.accessSession !== undefined
    ? { accessSession: credentials.accessSession }
    : {}),
});

type LoginLock = <T>(operation: () => Promise<T>) => Promise<T>;

export async function login(
  config: WeldallConfig,
  openBrowser: BrowserOpener = browserOpener,
  lock: LoginLock = (operation) => withCredentialLock(config.issuer, operation),
) {
  return lock(async () => {
    const key = await generateEs256KeyPair();
    const state = randomValue();
    const nonce = randomValue();
    const pkce = createPkce();
    const callback = await loopback(state, config.issuer);
    const callbackCode = callback.code;
    void callbackCode.catch(() => undefined);
    const authorize = new URL(config.authorize);
    for (const [name, value] of Object.entries({
      response_type: "code",
      prompt: "consent",
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
      await callbackCode.catch(() => undefined);
      throw new CliError("Unable to open the Weldall login page in your browser", {
        cause: error,
        hint: "Check that a default browser and your platform URL opener are available, then run `weldall login` again.",
      });
    }

    const code = await callbackCode;
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
    await keychain.set(config.issuer, {
      ...key,
      refreshToken: validated.refreshToken,
      accessSession: {
        accessToken: validated.accessToken,
        subject: validated.subject,
        expiresAt: validated.expiresAt as number,
      },
    });
    return validated.subject;
  });
}

export type { AccessSession } from "./session-manager.js";

export async function withAccess<T>(
  config: WeldallConfig,
  operation: (session: AccessSession) => Promise<T>,
): Promise<T> {
  return operation(await new SessionManager(config).getAccessSession());
}

export async function whoAmI(config: WeldallConfig) {
  return withAccess(config, async (session) => {
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
      CONFIG_REFRESH_HINT,
    );
    if (!isRecord(value) || typeof value.sub !== "string" || value.sub !== session.subject)
      throw new CliError("Weldall returned inconsistent identity information");
    const subject = value.sub;
    const name = typeof value.name === "string" ? value.name.trim() : "";
    const email = typeof value.email === "string" ? value.email.trim() : "";
    if (!name || !email || value.email_verified !== true)
      throw new CliError("Weldall did not return your verified profile", {
        hint: "Run `weldall logout`, then `weldall login` to refresh your account details.",
      });
    await withCredentialLock(config.issuer, async () => {
      const current = await keychain.get(config.issuer);
      if (!current || current.version !== 2 || current.accessSession?.subject !== session.subject)
        return;
      if (
        current.identity?.subject === subject &&
        current.identity.name === name &&
        current.identity.email === email
      )
        return;
      await keychain.set(config.issuer, {
        ...storedInput(current),
        identity: { subject, name, email },
      });
    });
    return { issuer: config.issuer, subject, name, email };
  });
}

export async function logout(config: WeldallConfig) {
  return withCredentialLock(config.issuer, async () => {
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
