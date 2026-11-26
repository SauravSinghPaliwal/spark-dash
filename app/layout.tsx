import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "SPARK — GB10 Console", description: "Live GPU, system and Docker operations console" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
