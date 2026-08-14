"use client";

import { useEffect, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { VStack } from "@astryxdesign/core/Stack";
import { authClient } from "@/lib/auth-client";
import { queueOperationSuccess, useOperationToast } from "../_components/use-operation-toast";

export function LoginOptions({ google, dev }: { google: boolean; dev: boolean }) {
  const session = authClient.useSession();
  const [pendingProvider, setPendingProvider] = useState<"google" | "dev-oidc" | null>(null);
  const operationToast = useOperationToast();

  useEffect(() => {
    if (session.isPending || !session.data) return;
    if (!window.location.search) queueOperationSuccess("Logged in", "auth-login");
    window.location.replace(
      window.location.search ? `/api/auth/oauth2/authorize${window.location.search}` : "/scopes",
    );
  }, [session.data, session.isPending]);

  const signIn = async (provider: "google" | "dev-oidc") => {
    if (pendingProvider) return;
    setPendingProvider(provider);
    try {
      const result = await authClient.signIn.social({
        provider,
        callbackURL: window.location.search
          ? window.location.href
          : `${window.location.origin}/scopes`,
      });
      if (result.error) {
        operationToast.error("Could not log in", result.error, "auth-login");
        setPendingProvider(null);
      }
    } catch (error) {
      operationToast.error("Could not log in", error, "auth-login");
      setPendingProvider(null);
    }
  };

  if (session.data)
    return <p>{window.location.search ? "Continuing authorization…" : "Redirecting…"}</p>;
  return (
    <VStack gap={2} hAlign="stretch">
      {google ? (
        <Button
          isDisabled={pendingProvider !== null && pendingProvider !== "google"}
          isLoading={pendingProvider === "google"}
          label="Continue with Google"
          onClick={() => void signIn("google")}
          variant="primary"
        />
      ) : null}
      {dev ? (
        <Button
          isDisabled={pendingProvider !== null && pendingProvider !== "dev-oidc"}
          isLoading={pendingProvider === "dev-oidc"}
          label="Development login"
          onClick={() => void signIn("dev-oidc")}
          variant={google ? "secondary" : "primary"}
        />
      ) : null}
    </VStack>
  );
}
