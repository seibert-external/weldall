"use client";

import {
  createContext,
  useContext,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { usePathname } from "next/navigation";
import { createPortal } from "react-dom";
import { Heading } from "@astryxdesign/core/Heading";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import { useThemeMode } from "../providers";

gsap.registerPlugin(useGSAP);

type AdminRoute = "audit" | "cli" | "resources" | "scopes" | "assignments" | "skills";
const designs = {
  audit: {
    title: "Audit logs",
    light: { from: "rgb(126, 45, 45)", to: "rgb(255, 205, 142)" },
    dark: { from: "rgb(72, 28, 28)", to: "rgb(112, 65, 30)" },
  },
  cli: {
    title: "CLI",
    light: { from: "rgb(130, 65, 0)", to: "rgb(255, 214, 153)" },
    dark: { from: "rgb(70, 36, 8)", to: "rgb(113, 70, 26)" },
  },
  resources: {
    title: "Resources",
    light: { from: "rgb(114, 53, 140)", to: "rgb(239, 199, 255)" },
    dark: { from: "rgb(52, 27, 66)", to: "rgb(87, 42, 105)" },
  },
  scopes: {
    title: "Scopes",
    light: { from: "rgb(69, 56, 202)", to: "rgb(234, 204, 255)" },
    dark: { from: "rgb(29, 31, 94)", to: "rgb(65, 36, 88)" },
  },
  assignments: {
    title: "Email assignments",
    light: { from: "rgb(0, 112, 86)", to: "rgb(219, 255, 170)" },
    dark: { from: "rgb(0, 58, 47)", to: "rgb(49, 75, 18)" },
  },
  skills: {
    title: "Skill registry",
    light: { from: "rgb(9, 78, 145)", to: "rgb(156, 231, 255)" },
    dark: { from: "rgb(12, 43, 78)", to: "rgb(21, 91, 112)" },
  },
} as const;

const ActionsContext = createContext<HTMLDivElement | null>(null);

export function AdminPageChrome({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [actionsTarget, setActionsTarget] = useState<HTMLDivElement | null>(null);
  const route = useMemo<AdminRoute>(() => {
    if (pathname.startsWith("/audit")) return "audit";
    if (pathname.startsWith("/cli")) return "cli";
    if (pathname.startsWith("/resources")) return "resources";
    if (pathname.startsWith("/assignments")) return "assignments";
    if (pathname.startsWith("/skills")) return "skills";
    return "scopes";
  }, [pathname]);

  return (
    <ActionsContext value={actionsTarget}>
      <div className="-mx-6 -mt-6 flex flex-col gap-6">
        <Herocrumbs route={route} setActionsTarget={setActionsTarget} />
        <div className="flex w-full flex-col gap-6 px-6 pb-6">{children}</div>
      </div>
    </ActionsContext>
  );
}

export function HerocrumbsActions({ children }: { children: ReactNode }) {
  const target = useContext(ActionsContext);
  return target ? createPortal(children, target) : null;
}

function Herocrumbs({
  route,
  setActionsTarget,
}: {
  route: AdminRoute;
  setActionsTarget: (target: HTMLDivElement | null) => void;
}) {
  const { mode } = useThemeMode();
  const design = designs[route];
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
    { dependencies: [design.title, gradient.from, gradient.to], scope: sectionRef },
  );

  return (
    <section
      ref={sectionRef}
      className="relative overflow-hidden px-6 py-6 text-white"
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
      <div className="relative flex w-full flex-wrap items-center justify-between gap-4">
        <Heading level={1} color="inherit" aria-label={design.title}>
          {Array.from(design.title).map((character, index) => (
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
          className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-2 empty:hidden"
        />
      </div>
    </section>
  );
}
