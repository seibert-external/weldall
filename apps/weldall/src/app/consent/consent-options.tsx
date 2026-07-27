"use client";

import { useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/Stack";
import { authClient } from "@/lib/auth-client";

export function ConsentOptions() {
  const [pending, setPending] = useState<"approve" | "deny" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const decide = async (accept: boolean) => {
    if (pending) return;
    setPending(accept ? "approve" : "deny");
    setError(null);
    try {
      const result = await authClient.oauth2.consent({
        accept,
        oauth_query: window.location.search.slice(1),
      });
      if (result.error) throw new Error(result.error.message ?? "Consent could not be processed");
      if (result.data && "url" in result.data && typeof result.data.url === "string") {
        window.location.assign(result.data.url);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Consent could not be processed");
      setPending(null);
    }
  };

  return (
    <>
      {error ? <p role="alert">{error}</p> : null}
      <HStack gap={2} hAlign="end">
        <Button
          isDisabled={pending !== null && pending !== "deny"}
          isLoading={pending === "deny"}
          label="Deny"
          onClick={() => void decide(false)}
          variant="secondary"
        />
        <Button
          isDisabled={pending !== null && pending !== "approve"}
          isLoading={pending === "approve"}
          label="Approve"
          onClick={() => void decide(true)}
          variant="primary"
        />
      </HStack>
    </>
  );
}
