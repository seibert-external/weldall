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
      <a className="directory-brand" href="/" aria-label="Skill directory home">
        {logoUrls.light ? (
          <ThemeLogo
            lightUrl={logoUrls.light}
            darkUrl={logoUrls.dark}
            alt="Company logo"
            width={958}
            height={245}
          />
        ) : (
          <img src="/assets/images/weldall.png" alt="Weldall" width={144} height={40} />
        )}
      </a>
      <div className="directory-header-actions">{children}</div>
    </header>
  );
}
