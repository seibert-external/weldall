"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import { usePathname } from "next/navigation";
import { createPortal } from "react-dom";
import { Heading } from "@astryxdesign/core/Heading";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import { useThemeMode } from "../providers";
import { corporateGradients } from "./corporate-palette";

gsap.registerPlugin(useGSAP);

// corporate-palette stores gradients as ordered tuples; nav designs need {from,to}.
function toPair(tuple: readonly [string, string]) {
  return { from: tuple[0], to: tuple[1] };
}

type AdminRoute =
  | "audit"
  | "cli"
  | "resources"
  | "machines"
  | "scopes"
  | "assignments"
  | "group-assignments"
  | "group-providers"
  | "login-providers"
  | "users"
  | "skills";
export const adminSectionDesigns = {
  audit: {
    title: "Audit logs",
    light: toPair(corporateGradients.pineTeal.light),
    dark: toPair(corporateGradients.pineTeal.dark),
  },
  cli: {
    title: "CLI",
    light: toPair(corporateGradients.pineApple.light),
    dark: toPair(corporateGradients.pineApple.dark),
  },
  machines: {
    title: "Machine clients",
    light: toPair(corporateGradients.teal.light),
    dark: toPair(corporateGradients.teal.dark),
  },
  resources: {
    title: "Resources",
    light: toPair(corporateGradients.darkLilac.light),
    dark: toPair(corporateGradients.darkLilac.dark),
  },
  scopes: {
    title: "Scopes",
    light: toPair(corporateGradients.lavender.light),
    dark: toPair(corporateGradients.lavender.dark),
  },
  assignments: {
    title: "Email assignments",
    light: toPair(corporateGradients.pine.light),
    dark: toPair(corporateGradients.pine.dark),
  },
  "group-assignments": {
    title: "Group assignments",
    light: toPair(corporateGradients.lake.light),
    dark: toPair(corporateGradients.lake.dark),
  },
  "login-providers": {
    title: "Login providers",
    light: toPair(corporateGradients.lavenderLight.light),
    dark: toPair(corporateGradients.lavenderLight.dark),
  },
  "group-providers": {
    title: "Group providers",
    light: toPair(corporateGradients.lavenderLight.light),
    dark: toPair(corporateGradients.lavenderLight.dark),
  },
  users: {
    title: "Users",
    light: toPair(corporateGradients.teal.light),
    dark: toPair(corporateGradients.teal.dark),
  },
  skills: {
    title: "Skill registry",
    light: toPair(corporateGradients.pineApple.light),
    dark: toPair(corporateGradients.pineApple.dark),
  },
} as const;

const ActionsContext = createContext<HTMLDivElement | null>(null);
const TitleContext = createContext<Dispatch<SetStateAction<string | null>>>(() => undefined);

export function AdminPageChrome({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [actionsTarget, setActionsTarget] = useState<HTMLDivElement | null>(null);
  const [title, setTitle] = useState<string | null>(null);
  const route = useMemo<AdminRoute>(() => {
    if (pathname.startsWith("/admin/audit")) return "audit";
    if (pathname.startsWith("/admin/cli")) return "cli";
    if (pathname.startsWith("/admin/machines")) return "machines";
    if (pathname.startsWith("/admin/resources")) return "resources";
    if (pathname.startsWith("/admin/assignments")) return "assignments";
    if (pathname.startsWith("/admin/group-assignments")) return "group-assignments";
    if (pathname.startsWith("/admin/group-providers")) return "group-providers";
    if (pathname.startsWith("/admin/login-providers")) return "login-providers";
    if (pathname.startsWith("/admin/users")) return "users";
    if (pathname.startsWith("/admin/skills")) return "skills";
    return "scopes";
  }, [pathname]);

  return (
    <TitleContext value={setTitle}>
      <ActionsContext value={actionsTarget}>
        <div className="-mx-6 -mt-6 flex flex-col gap-6">
          <Herocrumbs route={route} setActionsTarget={setActionsTarget} title={title} />
          <div className="flex w-full flex-col gap-6 px-6 pb-6">{children}</div>
        </div>
      </ActionsContext>
    </TitleContext>
  );
}

export function HerocrumbsActions({ children }: { children: ReactNode }) {
  const target = useContext(ActionsContext);
  return target ? createPortal(children, target) : null;
}

export function HerocrumbsTitle({ title }: { title: string }) {
  const setTitle = useContext(TitleContext);

  useEffect(() => {
    setTitle(title);
    return () => setTitle((currentTitle) => (currentTitle === title ? null : currentTitle));
  }, [setTitle, title]);

  return null;
}

function Herocrumbs({
  route,
  setActionsTarget,
  title: titleOverride,
}: {
  route: AdminRoute;
  setActionsTarget: (target: HTMLDivElement | null) => void;
  title: string | null;
}) {
  const { mode } = useThemeMode();
  const design = adminSectionDesigns[route];
  const title = titleOverride ?? design.title;
  const sectionRef = useRef<HTMLElement>(null);
  const noiseRef = useRef<HTMLDivElement>(null);
  const previousGradient = useRef<{ from: string; to: string } | null>(null);
  const gradient = design[mode];

  useGSAP(
    () => {
      const section = sectionRef.current;
      if (!section) return;
      const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const characters = gsap.utils.toArray<HTMLElement>(".herocrumbs-char", section);
      if (reduceMotion) {
        gsap.set(characters, { opacity: 1, y: 0, filter: "blur(0px)" });
        gsap.set(section, {
          "--headline-gradient-from": gradient.from,
          "--headline-gradient-to": gradient.to,
        });
        previousGradient.current = gradient;
        return;
      }

      gsap.fromTo(
        characters,
        { opacity: 0, y: 10, filter: "blur(4px)" },
        {
          opacity: 1,
          y: 0,
          filter: "blur(0px)",
          duration: 0.15,
          ease: "power2.out",
          stagger: { each: 0.01, from: "random" },
          overwrite: "auto",
        },
      );
      const previous = previousGradient.current;
      if (previous) {
        gsap.fromTo(
          section,
          {
            "--headline-gradient-from": previous.from,
            "--headline-gradient-to": previous.to,
          },
          {
            "--headline-gradient-from": gradient.from,
            "--headline-gradient-to": gradient.to,
            duration: 0.45,
            ease: "power2.out",
            overwrite: "auto",
          },
        );
        if (noiseRef.current) {
          gsap.fromTo(
            noiseRef.current,
            { backgroundPositionY: "0px" },
            {
              backgroundPositionY: "-160px",
              duration: 0.45,
              ease: "power2.out",
              overwrite: "auto",
            },
          );
        }
      } else {
        gsap.set(section, {
          "--headline-gradient-from": gradient.from,
          "--headline-gradient-to": gradient.to,
        });
      }
      previousGradient.current = gradient;
    },
    { dependencies: [title, gradient.from, gradient.to], scope: sectionRef },
  );

  return (
    <section
      ref={sectionRef}
      className="relative h-20 overflow-hidden px-6 text-white"
      style={
        {
          "--headline-gradient-from": gradient.from,
          "--headline-gradient-to": gradient.to,
          backgroundImage:
            "linear-gradient(100deg, var(--headline-gradient-from) -21.3%, var(--headline-gradient-to) 89.88%)",
        } as CSSProperties
      }
    >
      <div
        ref={noiseRef}
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-30"
        style={{
          backgroundImage: "url(/assets/images/noise.png)",
          backgroundRepeat: "repeat",
        }}
      />
      <div className="relative flex h-full w-full flex-nowrap items-center justify-between gap-4 overflow-x-auto overflow-y-hidden">
        <Heading level={1} color="inherit" aria-label={title} className="shrink-0">
          {Array.from(title).map((character, index) => (
            <span
              aria-hidden="true"
              className="herocrumbs-char inline-block"
              key={`${route}-${index}`}
            >
              {character === " " ? "\u00a0" : character}
            </span>
          ))}
        </Heading>
        <div
          ref={setActionsTarget}
          className="herocrumbs-actions ml-auto flex shrink-0 flex-nowrap items-center justify-end gap-2 empty:hidden"
        />
      </div>
    </section>
  );
}
