"use client";

import { Button } from "@astryxdesign/core/Button";
import { authClient } from "@/lib/auth-client";

export function SignOutButton() {
  return (
    <Button
      label="Sign out"
      onClick={async () => {
        await authClient.signOut();
        window.location.assign("/login");
      }}
      variant="secondary"
    />
  );
}
