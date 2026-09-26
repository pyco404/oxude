import type { NextConfig } from "next";

// The dev-tools badge floats over the transcript, which is the thing people screenshot.
const config: NextConfig = {
  reactStrictMode: true,
  devIndicators: false,
  // /how was the explainer's first address; it became /about.
  redirects: async () => [{ source: "/how", destination: "/about", permanent: true }],
  // The standalone exit is a static folder in public/, not a route, so a bare
  // /exit does not find its index.html on its own. Rewritten rather than
  // redirected: the address people are told is /exit, and it should stay that
  // in the bar - this is the page someone reaches for when things are already
  // going wrong.
  rewrites: async () => [{ source: "/exit", destination: "/exit/index.html" }],
};
export default config;
