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
            { slug: "compatibility" },
            { slug: "skill-classification" },
            { slug: "agent-run" },
            { label: "Features", link: "/features/" },
            { slug: "oauth-security" },
            { label: "SDKs", link: "/sdks/" },
            {
              label: "Discovery proxy",
              translations: { de: "Discovery-Proxy" },
              link: "/discovery-proxy/",
            },
            {
              label: "How to: Set up Weldall",
              translations: { de: "How to: Weldall aufsetzen" },
              link: "/weldall-setup/",
            },
            {
              label: "How to: Run the installer",
              translations: { de: "How to: Installer ausführen" },
              link: "/installer/",
            },
            {
              label: "How to: Develop locally",
              translations: { de: "How to: Lokal entwickeln" },
              link: "/local-development/",
            },
            {
              label: "How to: Integrate a service",
              translations: { de: "How to: Service integrieren" },
              items: [
                { slug: "service-configuration/typescript" },
                { slug: "service-configuration/python" },
                { slug: "service-configuration" },
              ],
            },
            { slug: "machine-authentication" },
            { slug: "group-provider-http-interface" },
            {
              label: "Infrastructure as code",
              translations: { de: "Infrastructure as Code" },
              link: "/infrastructure-as-code/",
            },
          ],
        },
      ],
      locales: {
        root: { label: "English", lang: "en" },
        de: { label: "Deutsch", lang: "de" },
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
