"use client";

import { useState, type ReactNode, type SVGProps } from "react";
import { usePathname } from "next/navigation";
import { AppShell } from "@astryxdesign/core/AppShell";
import {
  SideNav,
  SideNavCollapseButton,
  SideNavItem,
  SideNavSection,
  useSideNavCollapse,
} from "@astryxdesign/core/SideNav";
import { authClient } from "@/lib/auth-client";
import { useThemeMode } from "../providers";

export function AdminFrame({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { mode, toggleMode } = useThemeMode();
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const selected = (href: string) => pathname === href || pathname.startsWith(`${href}/`);

  return (
    <AppShell
      height="fill"
      variant="elevated"
      contentPadding={0}
      sideNav={
        <div
          className="h-full shrink-0 overflow-hidden transition-[width] duration-300 ease-out"
          style={{ width: isCollapsed ? 48 : 280 }}
        >
          <SideNav
            className="relative"
            collapsible={{
              hasButton: false,
              isCollapsed,
              onCollapsedChange: setIsCollapsed,
            }}
            header={<WeldallHeader />}
            footer={
              <SideNavSection title="Preferences" isHeaderHidden>
                <SideNavItem
                  label={mode === "dark" ? "Light mode" : "Dark mode"}
                  icon={ThemeIcon}
                  onClick={toggleMode}
                />
                <SideNavItem
                  label="Log out"
                  icon={LogoutIcon}
                  isDisabled={isLoggingOut}
                  onClick={() => {
                    if (isLoggingOut) return;
                    setIsLoggingOut(true);
                    void authClient.signOut().finally(() => window.location.assign("/login"));
                  }}
                />
              </SideNavSection>
            }
            style={{ width: "100%" }}
          >
            <div className="absolute top-1/2 right-2 z-20 -translate-y-1/2">
              <SideNavCollapseButton />
            </div>
            <SideNavSection title="Administration" isHeaderHidden>
              <SideNavItem label="CLI" href="/cli" icon={CliIcon} isSelected={selected("/cli")} />
              <SideNavItem
                label="Scopes"
                href="/scopes"
                icon={ScopeIcon}
                isSelected={selected("/scopes")}
              />
              <SideNavItem
                label="Assignments"
                href="/assignments"
                icon={AssignmentIcon}
                isSelected={selected("/assignments")}
              />
              <SideNavItem
                label="Skill registry"
                href="/skills"
                icon={SkillIcon}
                isSelected={selected("/skills")}
              />
            </SideNavSection>
          </SideNav>
        </div>
      }
    >
      <div className="min-h-full p-6">{children}</div>
    </AppShell>
  );
}

function WeldallHeader() {
  const { isCollapsed } = useSideNavCollapse();
  return isCollapsed ? (
    <div className="border-border bg-surface mx-auto grid h-8 w-8 place-items-center rounded-md border text-sm font-semibold">
      W
    </div>
  ) : (
    <div className="flex min-h-8 items-center px-2 text-lg font-semibold">Weldall</div>
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

function CliIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M4 5h16v14H4z" />
      <path d="m7 9 3 3-3 3M12 15h5" />
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

function AssignmentIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M15 19v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1" />
      <circle cx="8.5" cy="7" r="3" />
      <path d="M15 8h7M18.5 4.5v7" />
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

function ThemeIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
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
