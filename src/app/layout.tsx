import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Spark — Vulcan OmniPro 220 Assistant",
  description:
    "A multimodal expert assistant for the Vulcan OmniPro 220 multiprocess welder. Powered by the Claude Agent SDK.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-paper text-ink">{children}</body>
    </html>
  );
}
