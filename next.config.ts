import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  cacheHandlers: {
    default: require.resolve('./cache-handler.ts'),
  },
};

export default nextConfig;
