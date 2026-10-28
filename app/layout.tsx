import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Market Dashboard",
  description: "Suivi de marché",
  robots: { index: false, follow: false },
  // On iOS, "Add to Home Screen" opens it full screen, with the status bar over the dark background
  appleWebApp: { capable: true, title: "Marché", statusBarStyle: "black-translucent" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#0b0e14",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr">
      <body>{children}</body>
    </html>
  );
}
