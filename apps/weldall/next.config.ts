import type { NextConfig } from "next";
const config: NextConfig = {
  output: "standalone",
  transpilePackages: ["@weldall/sdk", "@weldall/db"],
  allowedDevOrigins: ["weldall.seibert.localdev"],
  async headers() {
    return [
      {
        source: "/connections/setup/:path*",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Cache-Control", value: "no-store" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ];
  },
};
export default config;
