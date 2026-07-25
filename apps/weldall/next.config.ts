import type { NextConfig } from "next";
const config: NextConfig = {
  transpilePackages: ["@weldall/sdk", "@weldall/db"],
  allowedDevOrigins: ["weldall.seibert.localdev"],
};
export default config;
