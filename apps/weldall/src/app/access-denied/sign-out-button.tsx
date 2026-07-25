"use client";

import { useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { authClient } from "@/lib/auth-client";
import { queueOperationSuccess, useOperationToast } from "../_components/use-operation-toast";

export function SignOutButton() {
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const operationToast = useOperationToast();

  const logOut = async () => {
    if (isLoggingOut) return;
    setIsLoggingOut(true);
    try {
      const result = await authClient.signOut();
      if (result.error) {
        operationToast.error("Could not log out", result.error, "auth-logout");
        setIsLoggingOut(false);
        return;
      }
      queueOperationSuccess("Logged out", "auth-logout");
      window.location.assign("/login");
    } catch (error) {
      operationToast.error("Could not log out", error, "auth-logout");
      setIsLoggingOut(false);
    }
  };

  return (
    <Button
      isLoading={isLoggingOut}
      label="Sign out"
      onClick={() => void logOut()}
      variant="secondary"
    />
  );
}
