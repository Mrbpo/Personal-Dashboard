import type { Metadata } from "next";
import "./globals.css";
import { WebMcpTools } from "@/components/webmcp-tools";

export const metadata: Metadata = {
  title: "Course Radar · Canvas 学习助手",
  description: "私人 Quercus 课程分析、截止日期追踪与每日学习清单。",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="antialiased">{children}<WebMcpTools /></body>
    </html>
  );
}
