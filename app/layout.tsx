import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Strike Guardian",
  description: "An autonomous Strike perps agent where every trade must pass a deterministic Guardian, and every decision is a signed, replayable receipt.",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#E8EBEF" },
    { media: "(prefers-color-scheme: dark)", color: "#121821" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,400..900&display=swap"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
