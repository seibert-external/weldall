import { auditRequestIdentifiers } from "@/server/audit/service";
import {
  completeAuthorizationCallback,
  rejectAuthorizationCallback,
} from "@/server/connectors/user-service";
import { withRequestLogging } from "@/server/observability/http";

const html = (title: string, message: string, status = 200) =>
  new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body><main><h1>${title}</h1><p>${message}</p></main></body></html>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy":
          "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
      },
    },
  );

async function get(request: Request) {
  const url = new URL(request.url);
  const stateValues = url.searchParams.getAll("state");
  const codeValues = url.searchParams.getAll("code");
  const errorValues = url.searchParams.getAll("error");
  const state = stateValues.length === 1 ? stateValues[0]! : "";
  const identifiers = auditRequestIdentifiers(request);
  if (
    stateValues.length !== 1 ||
    codeValues.length > 1 ||
    errorValues.length > 1 ||
    (codeValues.length === 1) === (errorValues.length === 1)
  ) {
    await rejectAuthorizationCallback(state, identifiers).catch(() => undefined);
    return html(
      "Connection failed",
      "The authorization response was invalid. Close this window and retry from the CLI.",
      400,
    );
  }
  if (errorValues.length === 1) {
    await rejectAuthorizationCallback(state, identifiers).catch(() => undefined);
    return html(
      "Connection not completed",
      "Google authorization was declined. Return to the CLI and try again.",
      400,
    );
  }
  const code = codeValues[0]!;
  try {
    const result = await completeAuthorizationCallback({ state, code }, identifiers);
    return html(
      "Google connected",
      `Connection ${escapeHtml(result.connectionName)} is ready for ${escapeHtml(result.accountDisplayName)}. You can close this window and return to the CLI.`,
    );
  } catch {
    return html(
      "Connection failed",
      "The authorization could not be completed. Close this window and retry from the CLI.",
      400,
    );
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character]!;
  });
}

export const GET = withRequestLogging("/api/connectors/google/callback", get);
