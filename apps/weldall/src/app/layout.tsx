import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import "./styles.css";
import { Providers } from "./providers";

export const metadata: Metadata = {
  title: "Weldall Skills",
  description: "Browse the agent skills available through Weldall.",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f1f1f1" },
    { media: "(prefers-color-scheme: dark)", color: "#171717" },
  ],
};

export default async function Layout({ children }: { children: React.ReactNode }) {
  const savedMode = (await cookies()).get("weldall-theme")?.value;
  const initialMode = savedMode === "light" || savedMode === "dark" ? savedMode : "system";

  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <Providers initialMode={initialMode}>{children}</Providers>
      </body>
    </html>
  );
}
