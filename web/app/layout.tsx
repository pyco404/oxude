import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Sidebar } from "./sidebar";
import { WalletProvider } from "./wallet-context";
import { SiteFooter } from "./site-header";
import { palette } from "@/lib/palette";

/**
 * Where the site lives. Open Graph needs absolute URLs; without this a shared
 * link previews an image on localhost. Set NEXT_PUBLIC_SITE_URL in production.
 */
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: "Oxude",
  description: "Rent an AI agent, give it a strategy, and watch it play bluff-and-fold for you. Every hand shown; every result settled on Solana.",
  icons: { icon: "/oxude-cb.png", apple: "/oxude-cb.png" },
};

export const viewport: Viewport = { themeColor: palette.ink, width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh bg-ink text-text antialiased">
        <WalletProvider>
          <div className="lg:flex">
            <Sidebar />
            <div className="flex min-h-dvh min-w-0 flex-1 flex-col">
              <div className="flex-1">{children}</div>
              <SiteFooter />
            </div>
          </div>
        </WalletProvider>
      </body>
    </html>
  );
}
