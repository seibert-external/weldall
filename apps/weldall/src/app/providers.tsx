"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { LayerProvider } from "@astryxdesign/core/Layer";
import { LinkProvider } from "@astryxdesign/core/Link";
import { Theme } from "@astryxdesign/core/theme";
import { neutralTheme } from "@astryxdesign/theme-neutral/built";
import { NuqsAdapter } from "nuqs/adapters/next/app";
import { TRPCReactProvider } from "@/trpc/react";
import { QueuedOperationToast } from "./_components/use-operation-toast";

type ThemeMode = "light" | "dark";
type ThemePreference = ThemeMode | "system";
interface ThemeModeValue {
  mode: ThemeMode;
  toggleMode: () => void;
}
const THEME_PREFERENCE_KEY = "weldall-theme";
const THEME_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

const ThemeModeContext = createContext<ThemeModeValue>({
  mode: "light",
  toggleMode: () => undefined,
});

export function useThemeMode() {
  return useContext(ThemeModeContext);
}

export function Providers({
  children,
  initialMode,
}: {
  children: ReactNode;
  initialMode: ThemePreference;
}) {
  const [mode, setMode] = useState<ThemePreference>(initialMode);

  useEffect(() => {
    if (initialMode !== "system") {
      window.localStorage.setItem(THEME_PREFERENCE_KEY, initialMode);
      return;
    }

    const saved = window.localStorage.getItem(THEME_PREFERENCE_KEY);
    if (saved === "light" || saved === "dark") {
      setMode(saved);
      writeThemeCookie(saved);
      return;
    }
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const sync = () => setMode(media.matches ? "dark" : "light");
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, [initialMode]);

  const toggleMode = () => {
    setMode((current) => {
      const resolved =
        current === "system"
          ? window.matchMedia("(prefers-color-scheme: dark)").matches
            ? "dark"
            : "light"
          : current;
      const next = resolved === "dark" ? "light" : "dark";
      window.localStorage.setItem(THEME_PREFERENCE_KEY, next);
      writeThemeCookie(next);
      return next;
    });
  };
  const resolvedMode = mode === "system" ? "light" : mode;

  return (
    <NuqsAdapter>
      <ThemeModeContext value={{ mode: resolvedMode, toggleMode }}>
        <Theme theme={neutralTheme} mode={mode}>
          <LinkProvider component={Link}>
            <LayerProvider toast={{ position: "bottomEnd", maxVisible: 4 }}>
              <QueuedOperationToast />
              <TRPCReactProvider>{children}</TRPCReactProvider>
            </LayerProvider>
          </LinkProvider>
        </Theme>
      </ThemeModeContext>
    </NuqsAdapter>
  );
}

function writeThemeCookie(mode: ThemeMode) {
  document.cookie = `${THEME_PREFERENCE_KEY}=${mode}; Path=/; Max-Age=${THEME_COOKIE_MAX_AGE}; SameSite=Lax`;
}
