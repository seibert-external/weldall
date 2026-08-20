"use client";

import { Button } from "@astryxdesign/core/Button";
import { useState } from "react";
import { authClient } from "../../lib/auth-client";

export function SignOutButton() {
  const [isPending, setIsPending] = useState(false);

  return (
    <Button
      isDisabled={isPending}
      isLoading={isPending}
      label="Log out"
      onClick={async () => {
        setIsPending(true);
        await authClient.signOut();
        window.location.replace("/");
      }}
      size="sm"
      variant="secondary"
    />
  );
}
