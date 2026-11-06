'use client';

import { useState, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import Link from 'next/link';
import { ArrowUpRight, Menu, X } from 'lucide-react';
import { externalEntries, sections, sectionHref } from '@/lib/uiv2/sections';
import styles from './console.module.css';

export function ConsoleShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const active = pathname.split('/')[2] || 'overview';
  return <div className={styles.root}>
    <a className={styles.skip} href="#uiv2-content">跳到内容</a>
    <header className={styles.mobileBar}>
      <Link href="/uiv2">STUDY / CONSOLE</Link>
      <button type="button" aria-label={open ? '关闭导航' : '打开导航'} aria-expanded={open} aria-controls="uiv2-navigation" onClick={() => setOpen(!open)}>{open ? <X size={20} /> : <Menu size={20} />}<span>导航</span></button>
    </header>
    <aside className={`${styles.sidebar} ${open ? styles.sidebarOpen : ''}`} id="uiv2-navigation">
      <Link className={styles.brand} href="/uiv2" onClick={() => setOpen(false)}><span className={styles.brandMark}>S/</span><span>Study Console<small>PERSONAL WORKSPACE · V2</small></span></Link>
      <nav aria-label="控制台导航" className={styles.navigation}>
        {['监测', '工作', '记录', '系统'].map(group => <div className={styles.navGroup} key={group}><p>{group}</p>{sections.filter(section => section.group === group).map(section => <Link key={section.key} href={sectionHref(section.key)} aria-current={active === section.key ? 'page' : undefined} onClick={() => setOpen(false)}><span>{section.label}</span><small>{section.english}</small></Link>)}</div>)}
      </nav>
      <div className={styles.sidebarFooter}><p>其他工作空间</p>{externalEntries.map(entry => <a key={entry.href} href={entry.href}>{entry.label}<ArrowUpRight size={14} aria-hidden="true" /></a>)}<small>独立界面 · 共用原有数据与权限</small></div>
    </aside>
    <div className={styles.workspace}>
      <div className={styles.topline}><span>PERSONAL / CONTROL ROOM</span><Link href="/">切换至经典界面 ↗</Link></div>
      <main id="uiv2-content" tabIndex={-1} className={styles.content}>{children}</main>
      <footer className={styles.footer}><span>Study Console / UI v2</span><span>私人工作空间 · 所有操作沿用现有服务</span></footer>
    </div>
  </div>;
}
