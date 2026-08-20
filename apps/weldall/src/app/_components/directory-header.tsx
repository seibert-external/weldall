import type { CliLogoUrls } from "@/server/branding";
import { ThemeLogo } from "./theme-logo";

export function DirectoryHeader({
  children,
  logoUrls,
}: {
  children: React.ReactNode;
  logoUrls: CliLogoUrls;
}) {
  return (
    <header className="directory-header">
      {logoUrls.light ? (
        <a className="directory-brand" href="/" aria-label="Skill directory home">
          <ThemeLogo
            lightUrl={logoUrls.light}
            darkUrl={logoUrls.dark}
            alt="Company logo"
            width={958}
            height={245}
          />
        </a>
      ) : null}
      <div className="directory-header-actions">{children}</div>
    </header>
  );
}
