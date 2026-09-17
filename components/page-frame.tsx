import Link from "next/link";
import { ArrowLeft, RefreshCw, Settings } from "lucide-react";

export function PageFrame({ eyebrow, title, description, children, ornament = false }: {
  eyebrow: string;
  title: string;
  description?: string;
  children: React.ReactNode;
  ornament?: boolean;
}) {
  return (
    <main className="min-h-screen bg-transparent">
      <header className="top-beam text-[#eee7d7]">
        <div className="mx-auto flex h-16 max-w-[1480px] items-center justify-between px-4 md:px-7">
          <Link href="/" className="flex items-center gap-2 text-sm font-medium text-[#cfc6b4] hover:text-white">
            <ArrowLeft className="size-4" /> 总 Dashboard
          </Link>
          <nav className="flex items-center gap-2">
            <Link href="/changes" className="border border-transparent p-2 text-[#cfc6b4] hover:border-[#9f8d68] hover:text-white" aria-label="最近变更"><RefreshCw className="size-4" /></Link>
            <Link href="/settings" className="border border-transparent p-2 text-[#cfc6b4] hover:border-[#9f8d68] hover:text-white" aria-label="设置"><Settings className="size-4" /></Link>
          </nav>
        </div>
      </header>
      {ornament && <div aria-hidden="true" style={{ height: 'clamp(104px, 12vw, 148px)', width: '100%', margin: 0, pointerEvents: 'none', backgroundImage: "url('/assets/vic3-theme/gothic-lattice-transparent.png')", backgroundSize: 'auto 100%', backgroundRepeat: 'repeat-x', backgroundPosition: 'center', clipPath: 'inset(0 0 12% 0)' }} />}
      <div className="mx-auto min-w-0 max-w-[1480px] px-4 py-6 md:px-7 md:py-8">
        <p className="section-kicker">{eyebrow}</p>
        <h1 className="break-words text-2xl font-semibold tracking-[-.02em] sm:text-3xl">{title}</h1>
        {description && <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground sm:text-base">{description}</p>}
        <div className="mt-7 min-w-0">{children}</div>
      </div>
    </main>
  );
}
