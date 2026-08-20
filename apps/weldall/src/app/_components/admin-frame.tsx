"use client";

import { useState, type CSSProperties, type ReactNode, type SVGProps } from "react";
import { usePathname } from "next/navigation";
import { AppShell } from "@astryxdesign/core/AppShell";
import {
  SideNav,
  SideNavItem,
  SideNavSection,
  useSideNavCollapse,
} from "@astryxdesign/core/SideNav";
import { authClient } from "@/lib/auth-client";
import { useThemeMode } from "../providers";
import { adminSectionDesigns } from "./herocrumbs";
import { queueOperationSuccess, useOperationToast } from "./use-operation-toast";

export function AdminFrame({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { mode, toggleMode } = useThemeMode();
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const operationToast = useOperationToast();
  const selected = (href: string) => pathname === href || pathname.startsWith(`${href}/`);
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
              <SideNavSection
                title="Preferences"
                isHeaderHidden
                className={isCollapsed ? undefined : "admin-footer-nav"}
              >
                <CollapseNavItem />
                <SideNavItem
                  label={mode === "dark" ? "Light mode" : "Dark mode"}
                  icon={ThemeIcon}
                  onClick={toggleMode}
                />
                <SideNavItem
                  label="Log out"
                  icon={LogoutIcon}
                  isDisabled={isLoggingOut}
                  onClick={() => void logOut()}
                />
              </SideNavSection>
            }
            style={{ width: "100%" }}
          >
            <SideNavSection
              title="Administration"
              isHeaderHidden
              className={isCollapsed ? undefined : "admin-section-nav"}
            >
              <SectionNavItem
                route="resources"
                label="Resources"
                href="/resources"
                icon={ResourceIcon}
                isSelected={selected("/resources")}
              />
              <SectionNavItem
                route="scopes"
                label="Scopes"
                href="/scopes"
                icon={ScopeIcon}
                isSelected={selected("/scopes")}
              />
              <SectionNavItem
                route="assignments"
                label="Email assignments"
                href="/assignments"
                icon={AssignmentIcon}
                isSelected={selected("/assignments")}
              />
              <SectionNavItem
                route="group-providers"
                label="Group providers"
                href="/group-providers"
                icon={GroupIcon}
                isSelected={selected("/group-providers")}
              />
              <SectionNavItem
                route="group-assignments"
                label="Group assignments"
                href="/group-assignments"
                icon={AssignmentIcon}
                isSelected={selected("/group-assignments")}
              />
              <SectionNavItem
                route="users"
                label="Users"
                href="/users"
                icon={UserIcon}
                isSelected={selected("/users")}
              />
              <SectionNavItem
                route="machines"
                label="Machine clients"
                href="/machines"
                icon={MachineIcon}
                isSelected={selected("/machines")}
              />
              <SectionNavItem
                route="skills"
                label="Skill registry"
                href="/skills"
                icon={SkillIcon}
                isSelected={selected("/skills")}
              />
              <SectionNavItem
                route="audit"
                label="Audit logs"
                href="/audit"
                icon={AuditIcon}
                isSelected={selected("/audit")}
              />
              <SectionNavItem
                route="cli"
                label="CLI"
                href="/cli"
                icon={CliIcon}
                isSelected={selected("/cli")}
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

function CollapseNavItem() {
  const { isCollapsed, toggle } = useSideNavCollapse();

  return (
    <SideNavItem
      label={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
      icon={isCollapsed ? ExpandSidebarIcon : CollapseSidebarIcon}
      onClick={toggle}
    />
  );
}

function SectionNavItem({
  route,
  label,
  href,
  icon,
  isSelected,
}: {
  route: keyof typeof adminSectionDesigns;
  label: string;
  href: string;
  icon: (props: IconProps) => ReactNode;
  isSelected: boolean;
}) {
  const { mode } = useThemeMode();
  const gradient = adminSectionDesigns[route][mode];

  return (
    <div
      className="admin-section-nav-item"
      data-selected={isSelected || undefined}
      style={
        {
          "--admin-nav-from": gradient.from,
          "--admin-nav-to": gradient.to,
        } as CSSProperties
      }
    >
      <SideNavItem label={label} href={href} icon={icon} isSelected={isSelected} />
    </div>
  );
}

function WeldallHeader() {
  const { isCollapsed } = useSideNavCollapse();
  return (
    <a href="/" aria-label="Open skill directory" className="block text-inherit no-underline">
      {isCollapsed ? (
        <div className="border-border bg-surface mx-auto grid h-8 w-8 place-items-center border text-sm font-semibold">
          W
        </div>
      ) : (
        <div className="admin-brand relative -m-2 flex h-20 w-[calc(100%+1rem)] items-center justify-center overflow-hidden">
          <div
            aria-hidden="true"
            className="admin-brand-noise pointer-events-none absolute inset-0"
            style={{
              backgroundImage: "url(/assets/images/noise.png)",
              backgroundRepeat: "repeat",
            }}
          />
          <img
            src="/assets/images/weldall.png"
            alt="Weldall"
            width={144}
            height={40}
            className="relative h-10 w-auto"
          />
        </div>
      )}
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

function AuditIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M5 4h14v16H5z" />
      <path d="M8 8h8M8 12h8M8 16h5" />
    </IconBase>
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

function MachineIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect x="4" y="6" width="16" height="12" rx="2" />
      <path d="M8 10h.01M12 10h4M8 14h8M12 3v3" />
    </IconBase>
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

function GroupIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="8" cy="8" r="3" />
      <circle cx="17" cy="9" r="2.5" />
      <path d="M2 20a6 6 0 0 1 12 0M13 20a5 5 0 0 1 9 0" />
    </IconBase>
  );
}

function UserIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21a8 8 0 0 1 16 0" />
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

function CollapseSidebarIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M4 4h16v16H4zM9 4v16" />
      <path d="m16 9-3 3 3 3" />
    </IconBase>
  );
}

function ExpandSidebarIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M4 4h16v16H4zM9 4v16" />
      <path d="m13 9 3 3-3 3" />
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
