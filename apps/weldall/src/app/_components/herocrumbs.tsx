"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import { usePathname } from "next/navigation";
import { createPortal } from "react-dom";
import { Heading } from "@astryxdesign/core/Heading";
import { corporateGradients } from "./corporate-palette";

// corporate-palette stores gradients as ordered tuples; nav designs need {from,to}.
function toPair(tuple: readonly [string, string]) {
  return { from: tuple[0], to: tuple[1] };
}

type AdminRoute =
  | "audit"
  | "cli"
  | "resources"
  | "connectors"
  | "connections"
  | "machines"
  | "scopes"
  | "assignments"
  | "group-assignments"
  | "group-providers"
  | "login-providers"
  | "users"
  | "skills";
export const adminSectionDesigns = {
  connectors: {
    title: "Connectors",
    light: toPair(corporateGradients.teal.light),
    dark: toPair(corporateGradients.teal.dark),
  },
  connections: {
    title: "Managed connections",
    light: toPair(corporateGradients.teal.light),
    dark: toPair(corporateGradients.teal.dark),
  },
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
    if (pathname.startsWith("/admin/connectors")) return "connectors";
    if (pathname.startsWith("/admin/connections")) return "connections";
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
  const title = titleOverride ?? adminSectionDesigns[route].title;

  return (
    <section className="relative h-20 overflow-hidden px-6">
      <div className="relative flex h-full w-full flex-nowrap items-center justify-between gap-4 overflow-x-auto overflow-y-hidden">
        <Heading level={1} color="inherit" className="shrink-0">
          {title}
        </Heading>
        <div
          ref={setActionsTarget}
          className="herocrumbs-actions ml-auto flex shrink-0 flex-nowrap items-center justify-end gap-2 empty:hidden"
        />
      </div>
    </section>
  );
}
