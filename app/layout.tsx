import type { Metadata } from "next";
import { Noto_Sans_Mono } from "next/font/google";
import "./styles.css";
import "katex/dist/katex.min.css";

const notoSansMono = Noto_Sans_Mono({
  subsets: ["latin", "cyrillic"],
  variable: "--font-noto-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "weclio",
  description: "weclio interface for the pi coding agent",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" translate="no" className={`${notoSansMono.variable} notranslate`} suppressHydrationWarning>
      <head>
        <meta name="google" content="notranslate" />
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var d=document.documentElement,t=localStorage.getItem("pi-theme");if(t==="dark")d.classList.add("dark");var w=Number(localStorage.getItem("pi-web:sidebar-width"));if(Number.isFinite(w)&&w>=240&&w<=480)d.style.setProperty("--saved-sidebar-width",w+"px")}catch(e){}})();`,
          }}
        />
      </head>
      <body translate="no" className="notranslate" style={{ height: "100dvh", display: "flex", flexDirection: "column" }}>
        {children}
      </body>
    </html>
  );
}
