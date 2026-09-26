import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { ConnectorError, RejectedProviderCredentials } from "../../errors";
import type { ConnectorProvider } from "../../provider";
import { googleSecretsSchema, parseGoogleConfiguration } from "./config";
import {
  canonicalizeScopes,
  listAvailableScopes,
  requiredScopes,
  scopeCatalog,
  selectionSchema,
  validateSelectedScopes,
} from "./setup";
import {
  buildGoogleAuthorizationUrl,
  completeGoogleAuthorization,
  credentialsSchema,
  googleRevocationToken,
  refreshGoogleCredentials,
  revokeGoogleAuthorization,
} from "./oauth";
import { parseGoogleGrant, validateGoogleGrant } from "./credentials";
import { resolveGoogleUpstreamUrl } from "./urls";

const attemptSchema = z
  .object({ verifier: z.string().min(32), nonce: z.string().min(32) })
  .strict();
/** Generates unpredictable OAuth state, nonce, or PKCE verifier material. */
const generateRandomToken = () => randomBytes(32).toString("base64url");

/** Google owns policy and token shapes; core receives only opaque validated values. */
export const googleProvider = {
  type: "google",
  parseConfiguration: parseGoogleConfiguration,
  parseSecrets: (value) => googleSecretsSchema.parse(value),
  /** Identifies the OAuth client to prevent rebinding existing connections to a different application. */
  getConfigurationIdentity: (value) => parseGoogleConfiguration(value).clientId,
  /** Offers provider-owned scope descriptions, never executable authorization claims. */
  describeSetup({ config, previousSelection }) {
    const parsed = parseGoogleConfiguration(config);
    return {
      scopes: listAvailableScopes(parsed),
      defaultScopes: parsed.defaultScopes,
      ...(previousSelection === undefined
        ? {}
        : { selection: selectionSchema.parse(previousSelection) }),
    };
  },
  /** Projects validated provider state for display without exposing private token material. */
  describeConnection({ selection, grant }) {
    const selectedScopes = selectionSchema.parse(selection).scopes;
    const grantedScopes = [...parseGoogleGrant(grant).scopes];
    const displayedScopes = new Set([...selectedScopes, ...grantedScopes]);
    return {
      selectedScopes,
      grantedScopes,
      scopeLabels: Object.fromEntries(
        scopeCatalog
          .filter(({ id }) => displayedScopes.has(id))
          .map(({ id, label }) => [id, label]),
      ),
    };
  },
  /** Reconnect retains only previously selected scopes still offered by the administrator. */
  buildInitialSelection({ config, previousSelection }) {
    const parsed = parseGoogleConfiguration(config);
    return {
      scopes: canonicalizeScopes([
        ...requiredScopes,
        ...(previousSelection === undefined
          ? parsed.defaultScopes
          : selectionSchema
              .parse(previousSelection)
              .scopes.filter((s) => parsed.allowedScopes.includes(s))),
      ]),
    };
  },
  /** Required identity scopes and the administrator's offered set bound owner consent. */
  validateSetupInput({ config, value }) {
    return {
      scopes: validateSelectedScopes({
        config: parseGoogleConfiguration(config),
        selected: selectionSchema.parse(value).scopes,
      }),
    };
  },
  /** Binds consent to fresh state, nonce, and PKCE; incremental Google grants are disabled. */
  async beginAuthorization({ config, selection, secrets, callbackUrl }) {
    const parsed = parseGoogleConfiguration(config);
    googleSecretsSchema.parse(secrets);
    const scopes = validateSelectedScopes({
      config: parsed,
      selected: selectionSchema.parse(selection).scopes,
    });
    const state = generateRandomToken(),
      verifier = generateRandomToken(),
      nonce = generateRandomToken();
    return {
      state,
      attempt: { verifier, nonce },
      url: buildGoogleAuthorizationUrl({
        clientId: parsed.clientId,
        redirectUri: callbackUrl,
        state,
        nonce,
        challenge: createHash("sha256").update(verifier).digest("base64url"),
        selected: scopes,
      }),
    };
  },
  /** Accepts only verified account identity and exact scope equality; rejected tokens are cleanup-only. */
  async completeAuthorization({ config, secrets, selection, callback, attempt, callbackUrl }) {
    const parsed = parseGoogleConfiguration(config);
    const code = callback.get("code");
    if (!code) throw new ConnectorError("invalid_callback", "Authorization code missing.");
    const state = attemptSchema.parse(attempt);
    const result = await completeGoogleAuthorization({
      client: { clientId: parsed.clientId, ...googleSecretsSchema.parse(secrets) },
      input: { code, redirectUri: callbackUrl, ...state },
    });
    try {
      return {
        ...result,
        grant: validateGoogleGrant({
          config,
          selection,
          credentials: result.credentials,
          grant: { scopes: result.credentials.grantedScopes },
        }),
      };
    } catch {
      throw new RejectedProviderCredentials({ credentials: result.credentials });
    }
  },
  parseCredentials: (value) => credentialsSchema.parse(value),
  parseGrant: parseGoogleGrant,
  needsRefresh: (value) => credentialsSchema.parse(value).expiresAt <= Date.now() + 60_000,
  /** Checks both sides of rotation so neither reduced nor expanded consent becomes executable. */
  async refreshCredentials({ config, secrets, selection, credentials, previousGrant }) {
    validateGoogleGrant({ config, selection, credentials, grant: previousGrant });
    const parsed = parseGoogleConfiguration(config);
    const next = await refreshGoogleCredentials({
      client: { clientId: parsed.clientId, ...googleSecretsSchema.parse(secrets) },
      previous: credentialsSchema.parse(credentials),
    });
    try {
      return {
        credentials: next,
        grant: validateGoogleGrant({
          config,
          selection,
          credentials: next,
          grant: { scopes: next.grantedScopes },
        }),
      };
    } catch {
      throw new RejectedProviderCredentials({ credentials: next });
    }
  },
  /** Google has no separately discoverable resource binding; local exact reconciliation is sufficient. */
  async ensureGrantCurrent({ config, selection, credentials, previousGrant }) {
    return validateGoogleGrant({ config, selection, credentials, grant: previousGrant });
  },
  /** Best-effort revocation reports uncertainty independently of local connection deletion. */
  async disconnectGrant({ config, secrets, credentials }) {
    parseGoogleConfiguration(config);
    googleSecretsSchema.parse(secrets);
    try {
      await revokeGoogleAuthorization(googleRevocationToken(credentials));
      return { status: "revoked" };
    } catch {
      return { status: "unconfirmed", remediationUrl: "https://myaccount.google.com/permissions" };
    }
  },
  /** Rechecks exact consent before restricting the target to Google's reviewed API origins. */
  resolveUpstreamUrl({ requestedUrl, config, selection, grant }) {
    const parsed = parseGoogleConfiguration(config);
    const requested = validateSelectedScopes({
      config: parsed,
      selected: selectionSchema.parse(selection).scopes,
    });
    if (JSON.stringify(requested) !== JSON.stringify(parseGoogleGrant(grant).scopes))
      throw new ConnectorError("grant_mismatch", "Provider grant differs from the request.");
    return resolveGoogleUpstreamUrl({ requestedUrl });
  },
  /** Only the adapter adds provider authorization; caller billing and identity overrides are removed. */
  buildUpstreamRequest({ credentials, request, signal }) {
    const headers = new Headers(request.headers);
    // Google-specific authentication and billing overrides cannot replace the connection's identity.
    for (const name of [...headers.keys()])
      if (name.startsWith("x-goog-") || name === "x-http-method-override") headers.delete(name);
    headers.set("authorization", `Bearer ${credentialsSchema.parse(credentials).accessToken}`);
    return {
      method: request.method,
      headers,
      ...(request.body === undefined ? {} : { body: Buffer.from(request.body) }),
      redirect: "error",
      signal,
    };
  },
} satisfies ConnectorProvider;
