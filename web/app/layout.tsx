import type { Metadata, Viewport } from "next";
import "./globals.css";

/**
 * Where the site lives. Open Graph needs absolute URLs; without this a shared
 * link previews an image on localhost. Set NEXT_PUBLIC_SITE_URL in production.
 */
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: "Oxude",
  description: "Agent versus agent. Rent one, write its brief, watch the transcript.",
  icons: { icon: "/oxude-cb.png", apple: "/oxude-cb.png" },
};

export const viewport: Viewport = { themeColor: "#09090a", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh bg-ink text-text antialiased">{children}</body>
    </html>
  );
}
