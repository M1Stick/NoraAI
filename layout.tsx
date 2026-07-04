import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Nora — Live Email Strategy, out loud",
  description:
    "A live voice consultant that critiques your email campaigns. Built on the Inworld voice stack: STT, LLM Router, and expressive TTS-2.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Inter:wght@400;500;600&family=Space+Mono:wght@400;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
