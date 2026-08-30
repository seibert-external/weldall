"use client";

import { useRef, useState, type CSSProperties, type ReactNode, type SVGProps } from "react";
import { usePathname } from "next/navigation";
import { Avatar } from "@astryxdesign/core/Avatar";
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import { authClient } from "@/lib/auth-client";
import { useThemeMode } from "../providers";
import { DirectoryPrimitiveSearch } from "./directory-primitive-search";
import { corporateGradients } from "./corporate-palette";

gsap.registerPlugin(useGSAP);

/**
 * On-brand gradient designs for the public directory nav items.
 * Mirrors the admin sidebar palette (see adminSectionDesigns) so the
 * hover/active treatment stays consistent across the app — all drawn from
 * the corporate identity palette instead of a rainbow.
 */
const publicSectionDesigns = {
  resources: { light: toPair(corporateGradients.darkLilac.light), dark: toPair(corporateGradients.darkLilac.dark) },
  skills: { light: toPair(corporateGradients.pineApple.light), dark: toPair(corporateGradients.pineApple.dark) },
  scopes: { light: toPair(corporateGradients.lavender.light), dark: toPair(corporateGradients.lavender.dark) },
  administration: { light: toPair(corporateGradients.pineTeal.light), dark: toPair(corporateGradients.pineTeal.dark) },
} as const;

function toPair(tuple: readonly [string, string]) {
  return { from: tuple[0], to: tuple[1] };
}

type SectionKey = keyof typeof publicSectionDesigns;

export function DirectoryUserMenu({ email, isAdmin }: { email: string; isAdmin: boolean }) {
  const pathname = usePathname();
  const { mode } = useThemeMode();
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [hoveredSection, setHoveredSection] = useState<SectionKey | null>(null);
  const navRef = useRef<HTMLElement>(null);
  const highlightRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef(new Map<SectionKey, HTMLAnchorElement>());
  const hasPositionedHighlight = useRef(false);
  const activeSection = getActiveSection(pathname);
  const highlightedSection = hoveredSection ?? activeSection;
  const highlightedGradient = highlightedSection
    ? publicSectionDesigns[highlightedSection][mode]
    : null;

  useGSAP(
    () => {
      const highlight = highlightRef.current;
      const item = highlightedSection ? itemRefs.current.get(highlightedSection) : null;
      if (!highlight || !item || !highlightedGradient) {
        if (highlight) gsap.to(highlight, { opacity: 0, duration: 0.15 });
        return;
      }

      const properties = {
        left: item.offsetLeft,
        width: item.offsetWidth,
        opacity: 1,
        "--directory-nav-from": highlightedGradient.from,
        "--directory-nav-to": highlightedGradient.to,
      };
      const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

      if (!hasPositionedHighlight.current) {
        // Keep the SSR-rendered active link intact until the first interaction.
        // Then place the shared highlight exactly underneath it before handing
        // off to GSAP, avoiding even a sub-pixel swap during initial loading.
        if (!hoveredSection) return;
        const originSection = activeSection ?? highlightedSection;
        const originItem = originSection ? itemRefs.current.get(originSection) : null;
        const originGradient = originSection ? publicSectionDesigns[originSection][mode] : null;
        gsap.set(highlight, {
          left: originItem?.offsetLeft ?? item.offsetLeft,
          width: originItem?.offsetWidth ?? item.offsetWidth,
          opacity: 1,
          "--directory-nav-from": originGradient?.from ?? highlightedGradient.from,
          "--directory-nav-to": originGradient?.to ?? highlightedGradient.to,
        });
        navRef.current?.setAttribute("data-highlight-ready", "true");
        hasPositionedHighlight.current = true;
      }

      if (reduceMotion) {
        gsap.set(highlight, properties);
      } else {
        gsap.to(highlight, {
          ...properties,
          duration: 0.32,
          ease: "power3.out",
          overwrite: "auto",
        });
      }
    },
    {
      dependencies: [
        activeSection,
        highlightedSection,
        highlightedGradient,
        hoveredSection,
        isAdmin,
        mode,
      ],
      scope: navRef,
    },
  );

  const logOut = async () => {
    if (isLoggingOut) return;
    setIsLoggingOut(true);
    await authClient.signOut();
    window.location.assign("/");
  };

  const setItemRef = (section: SectionKey, element: HTMLAnchorElement | null) => {
    if (element) itemRefs.current.set(section, element);
    else itemRefs.current.delete(section);
  };

  return (
    <>
      <DirectoryPrimitiveSearch />

      <nav
        ref={navRef}
        className="directory-nav"
        aria-label="Browse"
        onMouseLeave={() => setHoveredSection(null)}
      >
        <div
          ref={highlightRef}
          className="directory-nav-highlight"
          aria-hidden="true"
          style={
            {
              "--directory-nav-from": highlightedGradient?.from,
              "--directory-nav-to": highlightedGradient?.to,
            } as CSSProperties
          }
        />
        <DirectoryNavLink
          href="/skills"
          label="Skills"
          icon={<SkillIcon />}
          section="skills"
          isActive={activeSection === "skills"}
          isHighlighted={highlightedSection === "skills"}
          gradient={publicSectionDesigns.skills[mode]}
          onPreview={setHoveredSection}
          setItemRef={setItemRef}
        />
        <DirectoryNavLink
          href="/resources"
          label="Resources"
          icon={<ResourceIcon />}
          section="resources"
          isActive={activeSection === "resources"}
          isHighlighted={highlightedSection === "resources"}
          gradient={publicSectionDesigns.resources[mode]}
          onPreview={setHoveredSection}
          setItemRef={setItemRef}
        />
        <DirectoryNavLink
          href="/scopes"
          label="Scopes"
          icon={<ScopeIcon />}
          section="scopes"
          isActive={activeSection === "scopes"}
          isHighlighted={highlightedSection === "scopes"}
          gradient={publicSectionDesigns.scopes[mode]}
          onPreview={setHoveredSection}
          setItemRef={setItemRef}
        />
        {isAdmin ? (
          <DirectoryNavLink
            href="/admin/resources"
            label="Administration"
            icon={<AdministrationIcon />}
            section="administration"
            isActive={activeSection === "administration"}
            isHighlighted={highlightedSection === "administration"}
            gradient={publicSectionDesigns.administration[mode]}
            onPreview={setHoveredSection}
            setItemRef={setItemRef}
          />
        ) : null}
      </nav>

      <DropdownMenu
        button={{
          isIconOnly: true,
          label: "Account",
          icon: <Avatar name={email} alt={email} size={40} />,
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
  if (pathname === "/admin" || pathname.startsWith("/admin/")) return "administration";
  return null;
}

function DirectoryNavLink({
  href,
  label,
  icon,
  section,
  isActive,
  isHighlighted,
  gradient,
  onPreview,
  setItemRef,
}: {
  href: string;
  label: string;
  icon: ReactNode;
  section: SectionKey;
  isActive: boolean;
  isHighlighted: boolean;
  gradient: { readonly from: string; readonly to: string };
  onPreview: (section: SectionKey | null) => void;
  setItemRef: (section: SectionKey, element: HTMLAnchorElement | null) => void;
}) {
  return (
    <a
      ref={(element) => setItemRef(section, element)}
      href={href}
      className="directory-nav-item"
      aria-current={isActive ? "page" : undefined}
      aria-label={label}
      data-highlighted={isHighlighted || undefined}
      style={
        {
          "--directory-nav-from": gradient.from,
          "--directory-nav-to": gradient.to,
        } as CSSProperties
      }
      onMouseEnter={() => onPreview(section)}
      onFocus={() => onPreview(section)}
      onBlur={() => onPreview(null)}
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
