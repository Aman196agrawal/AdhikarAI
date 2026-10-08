import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "AdhikarAI",
  description:
    "Finding your benefits is not enough. AdhikarAI makes sure you receive them.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-dvh">
        {/*
          A prototype notice, shown on every screen.

          Government status and payment data in this build come from a
          simulation. Saying so once in a README is not enough when the screen
          shows a citizen that money was released; the claim has to carry its
          own caveat wherever it appears.
        */}
        <div className="border-b bg-[var(--demo-soft)] px-4 py-2 text-center text-sm text-[var(--demo)]">
          <span aria-hidden="true">▲ </span>
          Prototype. Government application and payment data shown here is
          simulated, not live.
        </div>
        {children}
      </body>
    </html>
  );
}
