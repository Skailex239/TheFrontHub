import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // Serve TheFrontHub static site at "/" — the index.html lives in /public.
  // beforeFiles rewrites run BEFORE the App Router filesystem routes, so the
  // static HTML is served without conflicting with src/app/page.tsx.
  async rewrites() {
    return {
      beforeFiles: [
        { source: "/", destination: "/index.html" },
      ],
    };
  },
};

export default nextConfig;
