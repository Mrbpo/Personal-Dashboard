export const sections = [
  { key: 'overview', label: '总览', english: 'Monitor', group: '监测', classic: '/', description: '截止任务、课程与最近变更。' },
  { key: 'tasks', label: '任务', english: 'Task queue', group: '工作', classic: '/#learning', description: '最近一周逾期与未来 16 天的未完成事项。' },
  { key: 'courses', label: '课程', english: 'Courses', group: '工作', classic: '/#learning', description: '已启用课程与截止任务；课程详情在经典界面打开。' },
  { key: 'study', label: '学习', english: 'Study', group: '工作', classic: '/study', description: '课程事实查询、学习对话与个人档案。' },
  { key: 'library', label: '资料库', english: 'Library', group: '记录', classic: '/library', description: '检索、上传与整理资料。文档阅读器在经典界面打开。' },
  { key: 'recordings', label: '录像', english: 'Recordings', group: '记录', classic: '/recordings', description: '课程录像、字幕与同步进度。' },
  { key: 'mail', label: '邮件', english: 'Mail', group: '记录', classic: '/mail', description: '收件、归档与课程关联。' },
  { key: 'health', label: '健康', english: 'Health', group: '监测', classic: '/health', description: '真实健康记录与按需 AI 分析。' },
  { key: 'ai-usage', label: 'AI 用量', english: 'AI usage', group: '系统', classic: '/#ai-usage', description: '服务连接、余额与可用用量信息。' },
  { key: 'settings', label: '设置', english: 'Preferences', group: '系统', classic: '/settings', description: '个人偏好、课程、访问与服务配置。' },
  { key: 'system', label: '系统', english: 'Operations', group: '系统', classic: '/settings', description: '后台任务、字幕处理与正式版本更新。' },
] as const;
export type SectionKey = typeof sections[number]['key'];
export type Section = typeof sections[number];
export const externalEntries = [
  { href: '/', label: '经典界面' },
  { href: '/hermes/', label: 'Hermes ↗' },
  { href: '/terminal/', label: '服务器终端 ↗' },
] as const;
export function sectionHref(key: SectionKey) { return key === 'overview' ? '/uiv2' : `/uiv2/${key}`; }
export function resolveSection(parts: string[] = []): { section: Section; classicDetail: string | null } | null {
  if (!parts.length) return { section: sections[0], classicDetail: null };
  const section = sections.find(item => item.key === parts[0]);
  if (!section) return null;
  if (parts.length === 1) return { section, classicDetail: null };
  // Only these existing classic detail routes are supported. Never import from user input.
  if (parts.length === 2 && ['library', 'courses'].includes(section.key) && parts[1] && !['.', '..'].includes(parts[1]) && !/[\\/\u0000-\u001f]/.test(parts[1])) {
    return { section, classicDetail: `/${section.key}/${encodeURIComponent(parts[1])}` };
  }
  return null;
}
export function safeSourceHref(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? url.href : undefined; } catch { return undefined; }
}
