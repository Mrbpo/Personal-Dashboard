import type { Metadata } from "next";
import "./theme.css";
import { WebMcpTools } from "@/components/webmcp-tools";

export const metadata: Metadata = {
  title: "Study Cabinet · 个人学习总览",
  description: "私人课程资料、日程、任务与 AI 服务总览。",
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
