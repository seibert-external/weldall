"use client";

import { useEffect, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { VStack } from "@astryxdesign/core/Stack";
import { authClient } from "@/lib/auth-client";
import { buttonForeground } from "@/server/auth/oidc-config";
import { queueOperationSuccess } from "../_components/use-operation-toast";

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
      setError("Login failed. Please retry or contact your administrator.");
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
