import type { NextConfig } from "next";
const config: NextConfig = {
  transpilePackages: ["@weldall/oauth", "@weldall/db"],
  allowedDevOrigins: ["weldall.seibert.localdev"],
};
export default config;
