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
interface ThemeModeValue {
  mode: ThemeMode;
  toggleMode: () => void;
}
const ThemeModeContext = createContext<ThemeModeValue>({
  mode: "light",
  toggleMode: () => undefined,
});

export function useThemeMode() {
  return useContext(ThemeModeContext);
}

export function Providers({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<ThemeMode>("light");

  useEffect(() => {
    const saved = window.localStorage.getItem("weldall-theme");
    if (saved === "light" || saved === "dark") {
      setMode(saved);
      return;
    }
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const sync = () => setMode(media.matches ? "dark" : "light");
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  const toggleMode = () => {
    setMode((current) => {
      const next = current === "dark" ? "light" : "dark";
      window.localStorage.setItem("weldall-theme", next);
      return next;
    });
  };

  return (
    <NuqsAdapter>
      <ThemeModeContext value={{ mode, toggleMode }}>
        <Theme theme={neutralTheme} mode={mode}>
          <LinkProvider component={Link}>
            <LayerProvider toast={{ position: "topEnd", maxVisible: 4 }}>
              <QueuedOperationToast />
              <TRPCReactProvider>{children}</TRPCReactProvider>
            </LayerProvider>
          </LinkProvider>
        </Theme>
      </ThemeModeContext>
    </NuqsAdapter>
  );
}
