import "./globals.css";
import type { Metadata, Viewport } from "next";
import { Outfit } from "next/font/google";

const outfit = Outfit({ subsets: ["latin"], display: "swap", variable: "--font-outfit" });

export const metadata: Metadata = {
  title: "PitchGuard",
  description: "Real-time stadium crowd safety",
};

export const viewport: Viewport = {
  themeColor: "#0f1115",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={outfit.variable}>
      <body className="font-display">{children}</body>
    </html>
  );
}
