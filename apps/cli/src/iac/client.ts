import { randomUUID } from "node:crypto";
import { createDpopProof, createMachineClientAssertion } from "@weldall/sdk";
import type { JWK } from "jose";
import { CliError } from "../errors.js";
import type { Lockfile, Manifest } from "./manifest.js";

interface Discovery {
  issuer: string;
  token_endpoint: string;
  weldall_iac?: { endpoint: string; installationId?: string; scope: string };
}
interface Credentials {
  clientId: string;
  kid: string;
  privateJwk: JWK;
  publicJwk: JWK;
}

function credentials(env: NodeJS.ProcessEnv = process.env): Credentials {
  const clientId = env.WELDALL_M2M_CLIENT_ID?.trim();
  const kid = env.WELDALL_M2M_KID?.trim();
  let privateJwk: JWK;
  let publicJwk: JWK;
  try {
    privateJwk = JSON.parse(env.WELDALL_M2M_PRIVATE_JWK ?? "") as JWK;
    publicJwk = JSON.parse(env.WELDALL_M2M_PUBLIC_JWK ?? "") as JWK;
  } catch {
    throw new CliError("M2M JWK environment values must be valid JSON");
  }
  if (
    !clientId ||
    !kid ||
    !privateJwk?.d ||
    publicJwk?.d ||
    privateJwk.kty !== "EC" ||
    publicJwk.kty !== "EC"
  )
    throw new CliError(
      "Set WELDALL_M2M_CLIENT_ID, WELDALL_M2M_KID, WELDALL_M2M_PRIVATE_JWK, and public WELDALL_M2M_PUBLIC_JWK",
    );
  return { clientId, kid, privateJwk, publicJwk };
}

export class IacClient {
  private constructor(
    private discovery: Discovery,
    private auth: Credentials,
    readonly installationId: string,
  ) {}
  static async connect(manifest: Manifest, lock: Lockfile | null): Promise<IacClient> {
    const url = new URL("/.well-known/oauth-authorization-server", manifest.workspace.issuer);
    const response = await fetch(url, {
      redirect: "error",
      headers: { accept: "application/json" },
    });
    if (!response.ok) throw new CliError(`Weldall discovery failed with HTTP ${response.status}`);
    const discovery = (await response.json()) as Discovery;
    if (
      discovery.issuer !== manifest.workspace.issuer ||
      !discovery.weldall_iac?.endpoint ||
      discovery.weldall_iac.scope !== "weldall:iac" ||
      !discovery.weldall_iac.installationId
    )
      throw new CliError("Server does not advertise native Weldall IaC v1");
    if (
      lock?.server.installationId &&
      lock.server.installationId !== discovery.weldall_iac.installationId
    )
      throw new CliError("Lockfile installation ID does not match this server; refusing mutation");
    return new IacClient(discovery, credentials(), discovery.weldall_iac.installationId);
  }
  private async token(): Promise<string> {
    const assertion = await createMachineClientAssertion({
      clientId: this.auth.clientId,
      kid: this.auth.kid,
      privateJwk: this.auth.privateJwk,
      tokenEndpoint: this.discovery.token_endpoint,
    });
    const dpop = await createDpopProof({
      method: "POST",
      url: this.discovery.token_endpoint,
      privateJwk: this.auth.privateJwk,
      publicJwk: this.auth.publicJwk,
    });
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.auth.clientId,
      client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      client_assertion: assertion,
      resource: `${this.discovery.issuer}/api`,
      scope: "weldall:iac",
    });
    const response = await fetch(this.discovery.token_endpoint, {
      method: "POST",
      redirect: "error",
      headers: { dpop, "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!response.ok)
      throw new CliError(`Machine token request failed with HTTP ${response.status}`);
    const value = (await response.json()) as { access_token?: string };
    if (!value.access_token) throw new CliError("Machine token response was invalid");
    return value.access_token;
  }
  async request(path: string, method: "GET" | "POST", body?: unknown): Promise<any> {
    const url = path.startsWith("http") ? path : `${this.discovery.weldall_iac!.endpoint}${path}`;
    const token = await this.token();
    const dpop = await createDpopProof({
      method,
      url,
      privateJwk: this.auth.privateJwk,
      publicJwk: this.auth.publicJwk,
      accessToken: token,
    });
    const response = await fetch(url, {
      method,
      redirect: "error",
      headers: {
        authorization: `DPoP ${token}`,
        dpop,
        accept: "application/json",
        ...(body ? { "content-type": "application/json", "x-idempotency-key": randomUUID() } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const value = (await response.json().catch(() => null)) as any;
    if (!response.ok)
      throw new CliError(value?.error?.message ?? `IaC API failed with HTTP ${response.status}`);
    return value;
  }
}
