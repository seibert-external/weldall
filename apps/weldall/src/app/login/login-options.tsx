"use client";

import { useEffect } from "react";
import { Button } from "@astryxdesign/core/Button";
import { VStack } from "@astryxdesign/core/Stack";
import { authClient } from "@/lib/auth-client";

export function LoginOptions({ google, dev }: { google: boolean; dev: boolean }) {
  const session = authClient.useSession();
  useEffect(() => {
    if (session.isPending || !session.data) return;
    window.location.replace(
      window.location.search ? `/api/auth/oauth2/authorize${window.location.search}` : "/",
    );
  }, [session.data, session.isPending]);

  const signIn = (provider: "google" | "dev-oidc") =>
    authClient.signIn.social({
      provider,
      callbackURL: window.location.search ? window.location.href : `${window.location.origin}/`,
    });

  if (session.data)
    return <p>{window.location.search ? "Continuing authorization…" : "Redirecting…"}</p>;
  return (
    <VStack gap={2} hAlign="stretch">
      {google ? (
        <Button
          label="Continue with Google"
          onClick={() => void signIn("google")}
          variant="primary"
        />
      ) : null}
      {dev ? (
        <Button
          label="Development login"
          onClick={() => void signIn("dev-oidc")}
          variant={google ? "secondary" : "primary"}
        />
      ) : null}
    </VStack>
  );
}
