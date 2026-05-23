import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "PitchGuard Command",
  description: "Real-time stadium crowd safety console",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="font-mono">{children}</body>
    </html>
  );
}
