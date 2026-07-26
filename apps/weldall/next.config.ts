import type { NextConfig } from "next";
const config: NextConfig = {
  output: "standalone",
  transpilePackages: ["@weldall/sdk", "@weldall/db"],
  allowedDevOrigins: ["weldall.seibert.localdev"],
};
export default config;
