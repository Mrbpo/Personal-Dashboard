export function deadlineLabel(task: {
  due_date: string | null; due_at: string | null; due_local_time: string | null;
  due_timezone: string | null; due_precision: string | null; due_original: string | null;
}): string {
  if (task.due_precision === 'date' && task.due_date) return `${task.due_date}（仅日期）`;
  if (task.due_date && task.due_local_time && task.due_timezone) {
    const time = task.due_precision === 'hour' ? task.due_local_time.slice(0, 2)
      : task.due_precision === 'minute' ? task.due_local_time.slice(0, 5)
      : task.due_local_time.slice(0, 8);
    return `${task.due_date} ${time} ${task.due_timezone}`;
  }
  if (task.due_at && task.due_precision !== 'date') return task.due_at;
  return task.due_original ? `待确认：${task.due_original}` : '未设置';
}

export function safeSourceUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : null;
  } catch { return null; }
}

export function factValue(value: unknown): string {
  if (value === null || value === undefined) return '无';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

export function reviewValue(attribute: string, value: unknown): string {
  if (attribute !== 'due' || !value || typeof value !== 'object' || Array.isArray(value))
    return factValue(value);
  const due = value as Record<string, unknown>;
  const field = (key: string) => typeof due[key] === 'string' ? due[key] as string : null;
  return deadlineLabel({ due_date: field('date'), due_at: field('at'),
    due_local_time: field('localTime'), due_timezone: field('timezone'),
    due_precision: field('precision'), due_original: field('original') });
}
