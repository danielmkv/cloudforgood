import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "contraiλ",
  description:
    "Real-time contrail formation risk prediction using GFS weather data and pycontrails.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
