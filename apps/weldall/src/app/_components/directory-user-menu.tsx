import { Button } from "@astryxdesign/core/Button";
import { SignOutButton } from "./sign-out-button";

export function DirectoryUserMenu({ email, isAdmin }: { email: string; isAdmin: boolean }) {
  return (
    <>
      <span className="directory-user-email">{email}</span>
      {isAdmin ? (
        <Button href="/resources" label="Administration" size="sm" variant="secondary" />
      ) : null}
      <SignOutButton />
    </>
  );
}
