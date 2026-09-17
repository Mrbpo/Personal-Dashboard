import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  devIndicators: false,
  outputFileTracingExcludes: { '*': ['./data/**/*', './.env*'] },
};

export default nextConfig;
