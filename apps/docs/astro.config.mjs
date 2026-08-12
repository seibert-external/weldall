// @ts-check
import react from "@astrojs/react";
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import lucode from "lucode-starlight";

// https://astro.build/config
export default defineConfig({
  integrations: [
    react(),
    starlight({
      title: "Weldall",
      logo: {
        src: "./src/assets/weldall.png",
        alt: "Weldall",
        replacesTitle: true,
      },
      plugins: [lucode()],
      customCss: ["./src/styles/logo.css"],
      sidebar: [
        {
          label: "Weldall Ecosystem",
          items: [{ slug: "ecosystem/overview" }],
        },
        {
          label: "Weldall CLI",
          items: [
            { slug: "index" },
            { slug: "agent-run" },
            { label: "Features", link: "/features/" },
            { slug: "oauth-security" },
            { label: "SDKs", link: "/sdks/" },
            {
              label: "How to: Weldall aufsetzen",
              translations: { en: "How to: Set up Weldall" },
              link: "/weldall-setup/",
            },
            { slug: "service-configuration" },
            { slug: "machine-authentication" },
            { slug: "group-provider-http-interface" },
          ],
        },
      ],
      locales: {
        root: { label: "Deutsch", lang: "de" },
        en: { label: "English", lang: "en" },
      },
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/seibert-external/weldall",
        },
      ],
    }),
  ],
});
