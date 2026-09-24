export type AskStage = 'request' | 'search' | 'answer' | 'response';

// Only fixed labels leave the server. Error messages can contain SQL or private data.
export function askFailureKind(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED') return 'DATABASE_BUSY';
  if (typeof code === 'string' && /^SQLITE_[A-Z0-9_]+$/.test(code)) return 'DATABASE_ERROR';

  const message = error instanceof Error ? error.message : '';
  if (/^OPENAI_[A-Z0-9_]+$/.test(message)) return message;
  if (message === 'AI 预算或每日请求上限已到；同步与已存资料仍可使用') return 'AI_BUDGET_EXCEEDED';
  if (error instanceof TypeError && message === 'fetch failed') return 'UPSTREAM_FETCH_FAILED';
  return 'UNCLASSIFIED';
}

export function askFailureMessage(stage: AskStage, kind: string): string {
  if (kind === 'AI_BUDGET_EXCEEDED') return 'AI 预算或每日请求上限已到；已存资料仍可查看';
  return stage === 'answer' ? 'AI 回答暂时不可用，请稍后重试' : '全站检索暂时不可用，请稍后重试';
}
