import { Button } from "@astryxdesign/core/Button";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "../server/auth/auth";
import { getEffectiveCliLogoUrls, type CliLogoUrls } from "../server/branding";
import { DirectoryHeader } from "./_components/directory-header";
import { ThemeLogo } from "./_components/theme-logo";

export const dynamic = "force-dynamic";

export default async function Home() {
  const [logoUrls, session] = await Promise.all([
    getEffectiveCliLogoUrls(),
    auth.api.getSession({ headers: await headers() }),
  ]);

  if (!session?.user.email) return <LoggedOutHome logoUrls={logoUrls} />;
  redirect("/skills");
}

function LoggedOutHome({ logoUrls }: { logoUrls: CliLogoUrls }) {
  return (
    <div className="public-home">
      <DirectoryHeader logoUrls={{ light: "", dark: "" }}>
        <Button href="/login" label="Log in" size="sm" variant="primary" />
      </DirectoryHeader>
      <main className="public-home-main">
        <div
          className="public-brand-lockup"
          aria-label={logoUrls.light ? "Weldall with custom branding" : "Weldall"}
        >
          <img
            src="/assets/images/weldall.png"
            alt="Weldall"
            width={364}
            height={101}
            className="public-brand-logo public-brand-weldall"
          />
          {logoUrls.light ? (
            <>
              <span className="public-brand-x" aria-hidden="true">
                ×
              </span>
              <ThemeLogo
                lightUrl={logoUrls.light}
                darkUrl={logoUrls.dark}
                alt="Configured company logo"
                width={958}
                height={245}
                className="public-brand-logo public-brand-company"
              />
            </>
          ) : null}
        </div>
        <p>Sign in to browse the skills available to your agent.</p>
        <Button href="/login" label="Log in to Weldall" variant="primary" />
      </main>
    </div>
  );
}
