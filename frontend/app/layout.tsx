import "./globals.css";
import type { ReactNode } from "react";

export const metadata = { title: "AI Roundtable", description: "Local multi-agent debate platform" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <main>{children}</main>
        <footer className="site-footer">Powered by <strong>Mukesh</strong></footer>
      </body>
    </html>
  );
}
