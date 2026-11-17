"use client";

import { useState, type ReactNode, type SVGProps } from "react";
import { usePathname } from "next/navigation";
import { Avatar } from "@astryxdesign/core/Avatar";
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { authClient } from "@/lib/auth-client";
import { DirectoryPrimitiveSearch } from "./directory-primitive-search";

type SectionKey = "skills" | "resources" | "scopes" | "statistics" | "administration";

export function DirectoryUserMenu({
  email,
  isAdmin,
  canViewStatistics,
}: {
  email: string;
  isAdmin: boolean;
  canViewStatistics: boolean;
}) {
  const pathname = usePathname();
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const activeSection = getActiveSection(pathname);

  const logOut = async () => {
    if (isLoggingOut) return;
    setIsLoggingOut(true);
    await authClient.signOut();
    window.location.assign("/");
  };

  return (
    <>
      <DirectoryPrimitiveSearch />

      <nav className="directory-nav" aria-label="Browse">
        <DirectoryNavLink
          href="/skills"
          label="Skills"
          icon={<SkillIcon />}
          isActive={activeSection === "skills"}
        />
        <DirectoryNavLink
          href="/resources"
          label="Resources"
          icon={<ResourceIcon />}
          isActive={activeSection === "resources"}
        />
        <DirectoryNavLink
          href="/scopes"
          label="Scopes"
          icon={<ScopeIcon />}
          isActive={activeSection === "scopes"}
        />
        {canViewStatistics ? (
          <DirectoryNavLink
            href="/statistics"
            label="Statistics"
            icon={<StatisticsIcon />}
            isActive={activeSection === "statistics"}
          />
        ) : null}
        {isAdmin ? (
          <DirectoryNavLink
            href="/admin/resources"
            label="Administration"
            icon={<AdministrationIcon />}
            isActive={activeSection === "administration"}
          />
        ) : null}
      </nav>

      <DropdownMenu
        button={{
          isIconOnly: true,
          label: "Account",
          icon: <Avatar name={email} alt={email} size={36} />,
          variant: "ghost",
          className: "directory-avatar-trigger",
        }}
        items={[
          {
            type: "section",
            title: email,
            items: [
              {
                label: "Log out",
                icon: <LogoutIcon />,
                isDisabled: isLoggingOut,
                onClick: () => void logOut(),
              },
            ],
          },
        ]}
      />
    </>
  );
}

function getActiveSection(pathname: string): SectionKey | null {
  if (pathname === "/skills" || pathname.startsWith("/skills/") || pathname.startsWith("/skill/")) {
    return "skills";
  }
  if (pathname === "/resources" || pathname.startsWith("/resources/")) return "resources";
  if (pathname === "/scopes" || pathname.startsWith("/scopes/")) return "scopes";
  if (pathname === "/statistics" || pathname.startsWith("/statistics/")) return "statistics";
  if (pathname === "/admin" || pathname.startsWith("/admin/")) return "administration";
  return null;
}

function DirectoryNavLink({
  href,
  label,
  icon,
  isActive,
}: {
  href: string;
  label: string;
  icon: ReactNode;
  isActive: boolean;
}) {
  return (
    <a
      href={href}
      className="directory-nav-item"
      aria-current={isActive ? "page" : undefined}
      aria-label={label}
    >
      {icon}
      <span>{label}</span>
    </a>
  );
}

type IconProps = SVGProps<SVGSVGElement>;

function IconBase(props: IconProps) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    />
  );
}

function ResourceIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="7" cy="7" r="3" />
      <circle cx="17" cy="17" r="3" />
      <path d="m9 9 6 6M14 6h4v4M6 14v4h4" />
    </IconBase>
  );
}

function SkillIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M5 3h11a3 3 0 0 1 3 3v15H8a3 3 0 0 1-3-3z" />
      <path d="M8 7h8M8 11h8M8 15h5" />
    </IconBase>
  );
}

function ScopeIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M5 5h14v5H5z" />
      <path d="M5 14h14v5H5z" />
      <path d="M8 7.5h.01M8 16.5h.01" />
    </IconBase>
  );
}

function StatisticsIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M4 20h16" />
      <path d="M7 16v-5M12 16V6M17 16v-8" />
    </IconBase>
  );
}

function AdministrationIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M4 21v-8h6v8M14 21V3h6v18" />
      <path d="M2 21h20M16.5 7h1M16.5 11h1M16.5 15h1" />
    </IconBase>
  );
}

function LogoutIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M10 17l5-5-5-5M15 12H3" />
      <path d="M15 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4" />
    </IconBase>
  );
}
