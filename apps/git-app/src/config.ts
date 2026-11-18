import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { loadEs256KeyPairFromEnv, type DpopKeyPair } from "@weldall/sdk";

type JWK = DpopKeyPair["publicJwk"];
import { GitAppError } from "./errors.js";
import {
  HOST_KINDS,
  parseHostConfiguration,
  parseHostSecret,
  type HostConfiguration,
} from "./hosts/index.js";

/**
 * Configuration of one Git app instance, read once at start from the environment. Every problem
 * is collected and reported together, naming the variable but never its value: secrets come only
 * from the environment or from a file whose path is given in the environment (`<NAME>_FILE`).
 * See the README for the full list.
 */
export interface GitAppConfig {
  host: HostConfiguration;
  /** GitHub App private key (canonical PKCS#8 PEM) or Forgejo bot token. Never logged or sent. */
  hostSecret: string;
  /** The instance's public origin, e.g. `https://git-app.example.com`: its authorization server. */
  publicOrigin: string;
  /** Resource identifier registered in Weldall, e.g. `https://git-app.example.com/api`. */
  resource: string;
  /** Downstream client ID registered on the resource in Weldall. */
  downstreamClientId: string;
  /** ES256 key the instance's authorization server signs its access tokens with. */
  signingKey: { kid: string; privateJwk: JWK; publicJwk: JWK };
  weldall: {
    /** Weldall's origin, e.g. `https://weldall.example.com`. */
    issuer: string;
    /** Machine client the instance uses for Weldall's app host API. */
    machineClientId: string;
    machineKid: string;
    machineKey: DpopKeyPair;
  };
  /** Resource scopes this instance checks. */
  scopes: { publish: string; admin: string };
  port: number;
}

export const DEFAULT_PUBLISH_SCOPE = "git-app:publish";
export const DEFAULT_ADMIN_SCOPE = "git-app:admin";
export const DEFAULT_PORT = 3002;

/** Failed configuration; the message lists every problem by variable name, never a value. */
export class GitAppConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(
      `Invalid Git app configuration:\n${problems.map((problem) => `- ${problem}`).join("\n")}`,
    );
    this.name = "GitAppConfigError";
  }
}

type Env = Readonly<Record<string, string | undefined>>;
type ReadFile = (path: string) => string;

const scopeKey = /^[a-z][a-z0-9._-]*:[a-z][a-z0-9._-]*$/;
const clientId = /^[A-Za-z0-9._:-]{1,128}$/;

function isLoopback(hostname: string) {
  return ["localhost", "127.0.0.1", "[::1]"].includes(hostname);
}

/** An https origin (http only on loopback, for local development), without path or credentials. */
function originProblem(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "must be an absolute URL";
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname)))
    return "must use https";
  if (url.username || url.password || url.search || url.hash || value !== url.origin)
    return "must be an origin without path, trailing slash, credentials, query or fragment";
  return null;
}

/**
 * Loads and validates the configuration. Fails fast with {@link GitAppConfigError}; nothing is
 * started with a partial configuration.
 */
export async function loadConfig(
  env: Env = process.env,
  readFile: ReadFile = (path) => readFileSync(path, "utf8"),
): Promise<GitAppConfig> {
  const problems: string[] = [];
  const text = (name: string, { required = true } = {}): string | undefined => {
    const value = env[name]?.trim();
    if (!value) {
      if (required) problems.push(`${name} is required.`);
      return undefined;
    }
    return value;
  };
  /** The value of NAME or the content of the file NAME_FILE names; exactly one of both. */
  const secret = (name: string): string | undefined => {
    const direct = env[name];
    const path = env[`${name}_FILE`]?.trim();
    if (direct && path) {
      problems.push(`Set either ${name} or ${name}_FILE, not both.`);
      return undefined;
    }
    if (path) {
      try {
        const content = readFile(path);
        if (!content.trim()) problems.push(`${name}_FILE names an empty file.`);
        return content;
      } catch {
        problems.push(`${name}_FILE names a file that cannot be read.`);
        return undefined;
      }
    }
    if (!direct?.trim()) {
      problems.push(`${name} or ${name}_FILE is required.`);
      return undefined;
    }
    return direct;
  };
  const origin = (name: string): string | undefined => {
    const value = text(name);
    if (value === undefined) return undefined;
    const problem = originProblem(value);
    if (problem) {
      problems.push(`${name} ${problem}.`);
      return undefined;
    }
    return value;
  };
  const scope = (name: string, fallback: string): string => {
    const value = text(name, { required: false }) ?? fallback;
    if (!scopeKey.test(value) || value.length > 160)
      problems.push(`${name} must be a scope key such as "${fallback}".`);
    return value;
  };
  const id = (name: string): string | undefined => {
    const value = text(name);
    if (value !== undefined && !clientId.test(value)) {
      problems.push(`${name} must be 1 to 128 letters, digits, ".", "_", ":" or "-".`);
      return undefined;
    }
    return value;
  };
  const keyPair = async (prefix: string) => {
    const privateValue = secret(`${prefix}_PRIVATE_JWK`);
    const publicValue = text(`${prefix}_PUBLIC_JWK`);
    if (privateValue === undefined || publicValue === undefined) return undefined;
    try {
      // The SDK's own errors name the variable, never the key material.
      return await loadEs256KeyPairFromEnv({
        privateName: `${prefix}_PRIVATE_JWK`,
        privateValue,
        publicName: `${prefix}_PUBLIC_JWK`,
        publicValue,
      });
    } catch {
      problems.push(
        `${prefix}_PRIVATE_JWK and ${prefix}_PUBLIC_JWK must be a matching ES256 (P-256) JWK pair.`,
      );
      return undefined;
    }
  };

  // Host
  const kindValue = text("GIT_APP_HOST");
  const kind = HOST_KINDS.find((candidate) => candidate === kindValue);
  if (kindValue !== undefined && !kind)
    problems.push(`GIT_APP_HOST must be one of: ${HOST_KINDS.join(", ")}.`);
  let host: HostConfiguration | undefined;
  const inlineConfig = env.GIT_APP_HOST_CONFIG?.trim();
  const configPath = env.GIT_APP_HOST_CONFIG_FILE?.trim();
  let rawConfig: string | undefined;
  if (inlineConfig && configPath)
    problems.push("Set either GIT_APP_HOST_CONFIG or GIT_APP_HOST_CONFIG_FILE, not both.");
  else if (configPath)
    try {
      rawConfig = readFile(configPath);
    } catch {
      problems.push("GIT_APP_HOST_CONFIG_FILE names a file that cannot be read.");
    }
  else if (inlineConfig) rawConfig = inlineConfig;
  else problems.push("GIT_APP_HOST_CONFIG or GIT_APP_HOST_CONFIG_FILE is required.");
  if (rawConfig !== undefined && kind) {
    let json: unknown;
    try {
      json = JSON.parse(rawConfig);
    } catch {
      problems.push("The host configuration is not valid JSON.");
    }
    if (json !== undefined)
      try {
        host = parseHostConfiguration(kind, json);
      } catch (error) {
        if (error instanceof z.ZodError)
          for (const issue of error.issues)
            problems.push(
              `Host configuration ${issue.path.length ? `field ${issue.path.join(".")}` : "value"}: ${issue.message}`,
            );
        else if (error instanceof GitAppError)
          problems.push(`Host configuration: ${error.message}`);
        else problems.push("The host configuration is invalid.");
      }
  }
  const rawSecret = secret("GIT_APP_HOST_SECRET");
  let hostSecret: string | undefined;
  if (rawSecret !== undefined && kind)
    try {
      hostSecret = parseHostSecret(kind, rawSecret);
    } catch (error) {
      // Fixed messages only (see `parseGitHubAppPrivateKey` and `parseForgejoToken`).
      problems.push(
        `GIT_APP_HOST_SECRET: ${error instanceof GitAppError ? error.message : "the secret is invalid."}`,
      );
    }

  // This instance as a resource
  const publicOrigin = origin("GIT_APP_PUBLIC_ORIGIN");
  const resourceValue = text("GIT_APP_RESOURCE_IDENTIFIER", { required: false });
  let resource = resourceValue ?? (publicOrigin ? `${publicOrigin}/api` : undefined);
  if (resourceValue !== undefined) {
    try {
      const url = new URL(resourceValue);
      if (!publicOrigin || url.origin !== publicOrigin || url.search || url.hash) throw new Error();
    } catch {
      problems.push(
        "GIT_APP_RESOURCE_IDENTIFIER must be a URL on GIT_APP_PUBLIC_ORIGIN without query or fragment.",
      );
      resource = undefined;
    }
  }
  const downstreamClientId = id("GIT_APP_DOWNSTREAM_CLIENT_ID");
  const signingKid = id("GIT_APP_SIGNING_KID");
  const signingPair = await keyPair("GIT_APP_SIGNING");
  const scopes = {
    publish: scope("GIT_APP_PUBLISH_SCOPE", DEFAULT_PUBLISH_SCOPE),
    admin: scope("GIT_APP_ADMIN_SCOPE", DEFAULT_ADMIN_SCOPE),
  };
  if (scopes.publish === scopes.admin)
    problems.push("GIT_APP_PUBLISH_SCOPE and GIT_APP_ADMIN_SCOPE must differ.");

  // Weldall
  const issuer = origin("WELDALL_ISSUER");
  const machineClientId = id("WELDALL_MACHINE_CLIENT_ID");
  const machineKid = id("WELDALL_MACHINE_KID");
  const machinePair = await keyPair("WELDALL_MACHINE");

  const portValue = text("PORT", { required: false });
  const port = portValue === undefined ? DEFAULT_PORT : Number(portValue);
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    problems.push("PORT must be a TCP port number.");

  if (
    problems.length ||
    !host ||
    hostSecret === undefined ||
    !publicOrigin ||
    !resource ||
    !downstreamClientId ||
    !signingKid ||
    !signingPair ||
    !issuer ||
    !machineClientId ||
    !machineKid ||
    !machinePair
  )
    throw new GitAppConfigError(problems.length ? problems : ["The configuration is incomplete."]);
  return {
    host,
    hostSecret,
    publicOrigin,
    resource,
    downstreamClientId,
    signingKey: { kid: signingKid, ...signingPair },
    weldall: {
      issuer,
      machineClientId,
      machineKid,
      machineKey: {
        ...machinePair,
        jkt: ecThumbprint(machinePair.publicJwk),
      },
    },
    scopes,
    port,
  };
}

/** RFC 7638 SHA-256 thumbprint of a validated P-256 public JWK (what DPoP's `jkt` names). */
function ecThumbprint(jwk: JWK): string {
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
  return createHash("sha256").update(canonical).digest("base64url");
}
