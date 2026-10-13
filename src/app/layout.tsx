import type { Metadata, Viewport } from "next";
import { Bricolage_Grotesque, JetBrains_Mono, Manrope } from "next/font/google";
import { Providers } from "@/components/providers";
import "./globals.css";

// Variable fonts (one file each, every weight): Manrope for the interface (tall x-height, tabular figures), JetBrains
// Mono for ids, logs and code, Bricolage Grotesque for page titles and hero numbers (see globals.css).
const sans = Manrope({ subsets: ["latin"], variable: "--font-ui-sans" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-ui-mono" });
const display = Bricolage_Grotesque({ subsets: ["latin"], variable: "--font-ui-display" });

export const metadata: Metadata = {
  title: "Deployment Console",
  description: "Services, CI, rollbacks and logs for your AWS ECS environments, in one place.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  colorScheme: "dark light",
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0b" },
    { media: "(prefers-color-scheme: light)", color: "#fafaf9" },
  ],
  viewportFit: "cover", // lets sheets pad for the home indicator via env(safe-area-inset-*)
  interactiveWidget: "resizes-content", // the on-screen keyboard shrinks the layout instead of covering sheets
};

// Set the theme before first paint (no flash): saved choice, else the OS preference.
const themeScript = `try{var t=localStorage.getItem("console.theme");if(!t)t=matchMedia("(prefers-color-scheme: light)").matches?"light":"dark";document.documentElement.dataset.theme=t}catch(e){document.documentElement.dataset.theme="dark"}`;
// Effects level (src/lib/client/perf.ts): the saved choice, else lite on weak devices (≤ 4 threads, ≤ 4 GB, Save-Data,
// reduce motion).
const perfScript = `try{var n=navigator,q=localStorage.getItem("console.perf"),w=(n.hardwareConcurrency||8)<=4||(n.deviceMemory||8)<=4||!!(n.connection&&n.connection.saveData)||matchMedia("(prefers-reduced-motion: reduce)").matches,d=document.documentElement;d.dataset.perfAuto=w?"lite":"full";d.dataset.perf=q==="full"||q==="lite"?q:d.dataset.perfAuto}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="dark" className={`${sans.variable} ${mono.variable} ${display.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript + perfScript }} />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
