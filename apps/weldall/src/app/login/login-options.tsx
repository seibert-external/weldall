"use client";

import { useEffect, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { VStack } from "@astryxdesign/core/Stack";
import { authClient } from "@/lib/auth-client";
import { buttonForeground } from "@/server/auth/oidc-config";
import { queueOperationSuccess } from "../_components/use-operation-toast";

const GENERIC_LOGIN_ERROR = "Login failed. Please retry or contact your administrator.";

// Only the codes of the Entra ID trust rules get a specific message. Every other code, including
// unknown or hostile query input, stays generic on purpose so failures reveal nothing else.
export function loginErrorMessage(code: string | null): string {
  switch (code) {
    case "entra_email_unverified":
      return "Microsoft Entra ID did not confirm a verified email address for your account. Ask your administrator to check the optional claims of the Weldall app registration and the email address of your account.";
    case "entra_claims_missing":
      return "Microsoft Entra ID did not send the acct claim Weldall needs. Ask your administrator to add the optional claim acct to the Weldall app registration.";
    case "entra_guest_denied":
      return "Guest accounts cannot sign in. Sign in with a member account of your organization.";
    default:
      return GENERIC_LOGIN_ERROR;
  }
}

export function LoginOptions({
  providers,
}: {
  providers: { id: string; buttonLabel: string; buttonColor: string; sortOrder: number }[];
}) {
  const session = authClient.useSession();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    if (query.has("loginError")) {
      setError(loginErrorMessage(query.get("loginError")));
      return;
    }
    if (session.isPending || !session.data) return;
    if (!query.size) queueOperationSuccess("Logged in", "auth-login");
    window.location.replace(query.size ? `/api/auth/oauth2/authorize?${query}` : "/");
  }, [session.data, session.isPending]);
  const signIn = async (providerId: string) => {
    if (pending) return;
    setPending(providerId);
    setError("");
    try {
      const query = new URLSearchParams(window.location.search);
      query.delete("loginError");
      const response = await fetch("/api/auth/oidc/start", {
        method: "POST",
        headers: { "content-type": "application/json", "x-weldall-csrf": "1" },
        body: JSON.stringify({ providerId, returnTo: query.size ? `/login?${query}` : "/" }),
      });
      const result = await response.json();
      if (!response.ok || typeof result.url !== "string") throw new Error();
      window.location.assign(result.url);
    } catch {
      setError("Could not start login. Please retry.");
      setPending(null);
    }
  };
  return (
    <VStack gap={2} hAlign="stretch">
      {error && <p role="alert">{error}</p>}
      {!providers.length && (
        <p>No login providers are enabled. Contact an administrator with an existing session.</p>
      )}
      {providers.map((provider) => (
        <Button
          key={provider.id}
          isDisabled={pending !== null}
          isLoading={pending === provider.id}
          label={provider.buttonLabel}
          onClick={() => void signIn(provider.id)}
          style={{
            backgroundColor: provider.buttonColor,
            color: buttonForeground(provider.buttonColor),
            width: "100%",
          }}
          type="button"
        />
      ))}
    </VStack>
  );
}
