import { createHash } from 'node:crypto';
import { serviceValue, seal, unseal } from './service-vault.ts';
import { aiResponse, hasAI } from './ai-response.ts';
import { getIntegrationConnection, saveIntegrationConnection, updateIntegrationStatus } from './repository.ts';
import { daysEnding, normalizeHealth, type HealthDay } from './health-data.ts';
const provider = 'google-health';
type Tokens = { access_token: string; refresh_token: string; expiresAt: number };
export const healthScopes = ['activity_and_fitness', 'sleep', 'health_metrics_and_measurements'].map(s => 'https://www.googleapis.com/auth/googlehealth.' + s + '.readonly');
export function healthConfig() {
  const clientId = serviceValue('GOOGLE_HEALTH_CLIENT_ID');
  const clientSecret = serviceValue('GOOGLE_HEALTH_CLIENT_SECRET');
  const redirectUri = serviceValue('GOOGLE_HEALTH_REDIRECT_URI') || 'http://localhost:3000/api/health/callback';
  const url = new URL(redirectUri);
  if (url.pathname !== '/api/health/callback' || url.search || url.hash || url.username || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) throw new Error('CONFIG');
  return { clientId, clientSecret, redirectUri, configured: Boolean(clientId && clientSecret) };
}
async function exchange(params: Record<string, string>): Promise<Tokens> {
  const config = healthConfig();
  const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, ...params }), signal: AbortSignal.timeout(20000), cache: 'no-store' });
  if (!response.ok) throw new Error('AUTH');
  const body = await response.json();
  if (typeof body.access_token !== 'string') throw new Error('AUTH');
  return { access_token: body.access_token, refresh_token: body.refresh_token || params.refresh_token || '', expiresAt: Date.now() + (Number(body.expires_in) || 3600) * 1000 };
}
export async function connectHealth(code: string, verifier: string) {
  const tokens = await exchange({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: healthConfig().redirectUri });
  if (!tokens.refresh_token) throw new Error('AUTH');
  await saveIntegrationConnection(provider, seal(tokens), {});
}
async function accessToken() {
  const connection = await getIntegrationConnection(provider);
  if (!connection) throw new Error('NOT_CONNECTED');
  let tokens = unseal<Tokens>(connection.encryptedSecret);
  if (tokens.expiresAt < Date.now() + 60000) {
    tokens = await exchange({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token });
    await saveIntegrationConnection(provider, seal(tokens), connection.metadata);
  }
  return tokens.access_token;
}
export async function healthStatus() {
  const connection = await getIntegrationConnection(provider);
  let configured = false; try { configured = healthConfig().configured; } catch {}
  return { configured, connected: Boolean(connection), aiConfigured: hasAI(), lastSyncedAt: connection?.lastSyncedAt || null, days: (connection?.metadata.days || []) as HealthDay[], errors: (connection?.metadata.errors || []) as string[], analysis: connection?.metadata.analysis || null, error: connection?.error || null };
}
async function query(token: string, type: string, suffix: string, params?: URLSearchParams, body?: unknown) {
  const output: any = { dataPoints: [], rollupDataPoints: [] };
  const query = params || new URLSearchParams();
  for (let page = 0; page < 50; page++) {
    const response = await fetch(`https://health.googleapis.com/v4/users/me/dataTypes/${type}/dataPoints${suffix}?${query}`, { method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000), cache: 'no-store' });
    if (!response.ok) throw new Error(response.status === 403 ? '未授权或 API 未启用' : response.status === 429 ? '请求频率受限，请稍后重试' : response.status === 401 ? '授权已失效，请重新连接' : '暂时无法读取');
    const data = await response.json();
    if (data.dataPoints) output.dataPoints.push(...data.dataPoints);
    if (data.rollupDataPoints) output.rollupDataPoints.push(...data.rollupDataPoints);
    if (!data.nextPageToken) return output;
    query.set('pageToken', data.nextPageToken);
  }
  throw new Error('记录过多，本次数据未完整读取');
}
let syncing: Promise<unknown> | null = null;
export function syncHealth(timezone: string) {
  if (syncing) return syncing;
  syncing = runSync(timezone).finally(() => { syncing = null; });
  return syncing;
}
async function runSync(timezone: string) {
  try {
    const token = await accessToken();
    const today = new Date().toLocaleDateString('en-CA', { timeZone: timezone });
    const days = daysEnding(today);
    const tomorrow = new Date(Date.parse(today + 'T12:00:00Z') + 86400000).toISOString().slice(0, 10);
    const civil = (date: string) => { const [year, month, day] = date.split('-').map(Number); return { date: { year, month, day }, time: {} }; };
    const filter = (name: string, field: string) => new URLSearchParams({ filter: `${name}.${field} >= "${days[0].date}" AND ${name}.${field} < "${tomorrow}"`, dataSourceFamily: 'users/me/dataSourceFamilies/google-wearables' });
    const specs = [
      ['steps', '步数', () => query(token, 'steps', ':dailyRollUp', undefined, { range: { start: civil(days[0].date), end: civil(tomorrow) }, windowSizeDays: 1, dataSourceFamily: 'users/me/dataSourceFamilies/google-wearables' })],
      ['sleep', '睡眠', () => query(token, 'sleep', ':reconcile', filter('sleep', 'interval.civil_end_time'))],
      ['heart', '静息心率', () => query(token, 'daily-resting-heart-rate', ':reconcile', filter('daily_resting_heart_rate', 'date'))],
      ['exercise', '运动', () => query(token, 'exercise', ':reconcile', filter('exercise', 'interval.civil_end_time'))],
    ] as const;
    const results = await Promise.allSettled(specs.map(s => s[2]()));
    const payloads: Record<string, any> = {}; const errors: string[] = [];
    results.forEach((result, i) => { if (result.status === 'fulfilled') payloads[specs[i][0]] = result.value; else errors.push(specs[i][1] + '：' + result.reason.message); });
    const current = await getIntegrationConnection(provider);
    if (results.every(r => r.status === 'rejected')) { await updateIntegrationStatus(provider, 'error', '同步失败，保留上次记录', { ...current?.metadata, errors }); return healthStatus(); }
    const normalized = normalizeHealth(days, payloads, timezone);
    // Failed categories retain their last known values; the UI identifies them as stale.
    const fields = ['steps', 'sleepMinutes', 'restingHeartRate', 'exerciseMinutes'] as const;
    results.forEach((r, i) => { if (r.status === 'rejected') for (const day of normalized) { const old = current?.metadata.days?.find((d: HealthDay) => d.date === day.date); if (old) day[fields[i]] = old[fields[i]]; } });
    await updateIntegrationStatus(provider, 'connected', null, { ...current?.metadata, days: normalized, errors, timezone });
    return healthStatus();
  } catch { await updateIntegrationStatus(provider, 'error', '授权或连接异常，请检查配置并重新连接'); return healthStatus(); }
}
export async function analyzeHealth() {
  const status = await healthStatus();
  if (!status.days.some(d => d.steps !== null || d.sleepMinutes !== null || d.restingHeartRate !== null)) throw new Error('NO_DATA');
  const key = serviceValue('OPENAI_API_KEY'); if (!hasAI()) throw new Error('NO_AI');
  const digest = createHash('sha256').update(JSON.stringify([status.days, status.errors])).digest('hex');
  if (status.analysis?.digest === digest) return status.analysis;
  const response = await aiResponse('https://api.openai.com/v1/responses', { method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: serviceValue('OPENAI_MODEL') || 'gpt-5-mini', store: false, max_output_tokens: 2400, instructions: '用简体中文解读用户的近七天 Fitbit 日汇总。写三个短段落：有数据支持的变化、数据局限、两条温和可执行的生活建议。每项观察注明日期和数值，区分当天未完成数据，null是缺失不是0，错误类别可能为旧数据。不得诊断疾病、推断病因、建议药物或编造健康评分。若无可靠趋势明确说明。不做单次值危险性判断。不提问，不引用不存在的资料。输入只包含记录和缺失提示。', input: JSON.stringify({ days: status.days, missingOrStale: status.errors, source: 'Fitbit via Google Health', syncedAt: status.lastSyncedAt }) }) });
  if (!response.ok) throw new Error('AI_FAILED');
  const result = await response.json();
  const text = result.output_text || result.output?.flatMap((x: any) => x.content || []).filter((x: any) => x.type === 'output_text').map((x: any) => x.text).join('\n');
  if (!text || result.status === 'incomplete') throw new Error('AI_FAILED');
  const analysis = { text, digest, generatedAt: new Date().toISOString(), model: result.model || serviceValue('OPENAI_MODEL') || 'gpt-5-mini', provider: result.provider || 'api' };
  const connection = await getIntegrationConnection(provider);
  if (connection) await saveIntegrationConnection(provider, connection.encryptedSecret, { ...connection.metadata, analysis }, connection.status);
  return analysis;
}
