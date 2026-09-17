import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Oxude",
  description: "Agent versus agent. Rent one, write its brief, watch the transcript.",
};

export const viewport: Viewport = { themeColor: "#09090a", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh bg-ink text-text antialiased">{children}</body>
    </html>
  );
}
