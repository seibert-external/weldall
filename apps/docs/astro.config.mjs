// @ts-check
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import lucode from "lucode-starlight";

// https://astro.build/config
export default defineConfig({
  integrations: [
    starlight({
      title: "Weldall",
      logo: {
        src: "./src/assets/weldall.png",
        alt: "Weldall",
        replacesTitle: true,
      },
      plugins: [lucode()],
      customCss: ["./src/styles/logo.css"],
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
