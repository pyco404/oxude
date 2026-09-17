import type { NextConfig } from "next";

// The dev-tools badge floats over the transcript, which is the thing people screenshot.
const config: NextConfig = { reactStrictMode: true, devIndicators: false };
export default config;
