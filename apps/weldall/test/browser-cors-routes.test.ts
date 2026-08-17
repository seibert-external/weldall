import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const browserRoutes = [
  ["../src/app/.well-known/oauth-authorization-server/route.ts", "GET"],
  ["../src/app/.well-known/oauth-protected-resource/api/route.ts", "GET"],
  ["../src/app/.well-known/openid-configuration/route.ts", "GET"],
  ["../src/app/api/auth/oauth2/device_authorization/route.ts", "POST"],
  ["../src/app/api/auth/oauth2/revoke/route.ts", "POST"],
  ["../src/app/api/auth/oauth2/token/route.ts", "POST"],
  ["../src/app/api/auth/oauth2/userinfo/route.ts", "GET"],
  ["../src/app/api/browser/resources/current/route.ts", "GET"],
  ["../src/app/api/me/grants/route.ts", "GET"],
  ["../src/app/api/me/scopes/route.ts", "GET"],
  ["../src/app/api/me/browser-connections/current/route.ts", "GET"],
  ["../src/app/api/me/browser-connections/current/revoke/route.ts", "POST"],
] as const;

describe("browser-facing Weldall route CORS wiring", () => {
  it.each(browserRoutes)(
    "wires %s through exact %s CORS and exports OPTIONS",
    async (path, method) => {
      const source = await readFile(new URL(path, import.meta.url), "utf8");
      expect(source).toContain(`withBrowserCors(["${method}"]`);
      expect(source).toMatch(new RegExp(`export const ${method}\\s*=\\s*withRequestLogging\\(`));
      expect(source).toMatch(/export const OPTIONS\s*=\s*withRequestLogging\(/);
      expect(source).not.toContain('withBrowserCors(["*"]');
    },
  );
});
