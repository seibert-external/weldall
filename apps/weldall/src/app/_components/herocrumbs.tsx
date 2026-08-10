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

gsap.registerPlugin(useGSAP);

type AdminRoute =
  | "audit"
  | "cli"
  | "resources"
  | "workloads"
  | "scopes"
  | "assignments"
  | "group-assignments"
  | "group-providers"
  | "users"
  | "skills";
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
  workloads: {
    title: "Workload clients",
    light: { from: "rgb(23, 91, 94)", to: "rgb(183, 244, 238)" },
    dark: { from: "rgb(12, 49, 52)", to: "rgb(25, 88, 88)" },
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
  "group-assignments": {
    title: "Group assignments",
    light: { from: "rgb(21, 94, 117)", to: "rgb(186, 230, 253)" },
    dark: { from: "rgb(15, 48, 61)", to: "rgb(26, 86, 105)" },
  },
  "group-providers": {
    title: "Group providers",
    light: { from: "rgb(91, 65, 123)", to: "rgb(233, 213, 255)" },
    dark: { from: "rgb(46, 31, 63)", to: "rgb(83, 52, 105)" },
  },
  users: {
    title: "Users",
    light: { from: "rgb(30, 78, 121)", to: "rgb(172, 224, 255)" },
    dark: { from: "rgb(18, 42, 67)", to: "rgb(33, 82, 104)" },
  },
  skills: {
    title: "Skill registry",
    light: { from: "rgb(9, 78, 145)", to: "rgb(156, 231, 255)" },
    dark: { from: "rgb(12, 43, 78)", to: "rgb(21, 91, 112)" },
  },
} as const;

const ActionsContext = createContext<HTMLDivElement | null>(null);
const TitleContext = createContext<Dispatch<SetStateAction<string | null>>>(() => undefined);

export function AdminPageChrome({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [actionsTarget, setActionsTarget] = useState<HTMLDivElement | null>(null);
  const [title, setTitle] = useState<string | null>(null);
  const route = useMemo<AdminRoute>(() => {
    if (pathname.startsWith("/audit")) return "audit";
    if (pathname.startsWith("/cli")) return "cli";
    if (pathname.startsWith("/workloads")) return "workloads";
    if (pathname.startsWith("/resources")) return "resources";
    if (pathname.startsWith("/assignments")) return "assignments";
    if (pathname.startsWith("/group-assignments")) return "group-assignments";
    if (pathname.startsWith("/group-providers")) return "group-providers";
    if (pathname.startsWith("/users")) return "users";
    if (pathname.startsWith("/skills")) return "skills";
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
  const design = designs[route];
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
        <Heading level={1} color="inherit" aria-label={title}>
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
          className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-2 empty:hidden"
        />
      </div>
    </section>
  );
}
