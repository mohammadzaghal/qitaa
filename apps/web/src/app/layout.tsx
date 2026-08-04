import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "قطعة Qitaa — Own a piece of Jordan",
  description:
    "3D spatial marketplace and fractional co-investment platform for Jordanian real estate.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" dir="ltr">
      <body className="h-full bg-basalt-950 text-sand-100 antialiased">{children}</body>
    </html>
  );
}
