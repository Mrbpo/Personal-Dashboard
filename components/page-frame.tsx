import Link from "next/link";
import { ArrowLeft, RefreshCw, Settings } from "lucide-react";

export function PageFrame({ eyebrow, title, description, children }: {
  eyebrow: string;
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <main className="min-h-screen bg-background">
      <header className="border-b bg-card/90 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 md:px-8">
          <Link href="/" className="flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground">
            <ArrowLeft className="size-4" /> 今日总览
          </Link>
          <nav className="flex items-center gap-2">
            <Link href="/changes" className="rounded-xl p-2 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="最近变更"><RefreshCw className="size-4" /></Link>
            <Link href="/settings" className="rounded-xl p-2 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="设置"><Settings className="size-4" /></Link>
          </nav>
        </div>
      </header>
      <div className="mx-auto max-w-6xl px-4 py-9 md:px-8">
        <p className="section-kicker">{eyebrow}</p>
        <h1 className="text-3xl font-semibold tracking-[-.03em] md:text-4xl">{title}</h1>
        {description && <p className="mt-2 max-w-2xl text-muted-foreground">{description}</p>}
        <div className="mt-8">{children}</div>
      </div>
    </main>
  );
}
