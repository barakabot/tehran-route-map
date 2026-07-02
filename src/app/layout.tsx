import type { Metadata } from "next";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

export const metadata: Metadata = {
  title: "نقشه تعاملی تهران - مدیریت مشتریان و مسیرها",
  description: "سیستم مدیریت مشتریان و مسیرهای توزیع شهر تهران با قابلیت‌های تعاملی",
  icons: {
    icon: "https://z-cdn.chatglm.cn/z-ai/static/logo.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="fa" dir="rtl" suppressHydrationWarning>
      <head>
        <link
          rel="stylesheet"
          href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"
          crossOrigin=""
        />
        <link
          rel="stylesheet"
          href="https://unpkg.com/@geoman-io/leaflet-geoman-free@2.20.0/dist/leaflet-geoman.css"
          crossOrigin=""
        />
        <style>{`
          .custom-tooltip {
            background: white !important;
            border: 1px solid #e5e7eb !important;
            border-radius: 8px !important;
            padding: 4px 8px !important;
            box-shadow: 0 4px 12px rgba(0,0,0,0.1) !important;
            direction: rtl;
            max-width: 300px;
          }
          .custom-tooltip::before {
            border-top-color: #e5e7eb !important;
          }
          .leaflet-pm-toolbar {
            display: none !important;
          }
          .leaflet-right .leaflet-control {
            margin-right: 10px;
          }
        `}</style>
      </head>
      <body className="antialiased bg-background text-foreground">
        {children}
        <Toaster />
      </body>
    </html>
  );
}