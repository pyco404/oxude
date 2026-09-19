import type { NextConfig } from "next";

// The dev-tools badge floats over the transcript, which is the thing people screenshot.
const config: NextConfig = {
  reactStrictMode: true,
  devIndicators: false,
  // /how was the explainer's first address; it became /about.
  redirects: async () => [{ source: "/how", destination: "/about", permanent: true }],
};
export default config;
