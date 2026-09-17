import { getCurrentOwner, requireOwnerApi } from '@/lib/authz';
import { getSettings, listTasks, listScheduleEvents } from '@/lib/repository';
import { getDatabase } from '@/lib/repository';
import { buildAgenda, type AgendaPrefs } from '@/lib/study-agenda';
import { sameOrigin } from '@/lib/service-vault';
async function state() {
  const owner = await getCurrentOwner();
  const db = getDatabase();
  await db.prepare('CREATE TABLE IF NOT EXISTS agenda_state (owner_id TEXT PRIMARY KEY, payload TEXT NOT NULL)').run();
  const settings = await getSettings(owner!.userId);
  const row = await db.prepare('SELECT payload FROM agenda_state WHERE owner_id=?').bind(owner!.userId).first<{payload:string}>();
  const data = row ? JSON.parse(row.payload) : { prefs: { start: '19:00', end: '22:00', minutes: settings.dailyMinutes, confirmed: false }, completed: [] };
  return { owner: owner!.userId, db, settings, data };
}
export async function GET() {
  const denied = await requireOwnerApi(); if (denied) return denied;
  const { settings, data } = await state();
  const now = Date.now();
  const events = await listScheduleEvents(new Date(now - 86400000).toISOString(), new Date(now + 15 * 86400000).toISOString());
  return Response.json({ ...buildAgenda(await listTasks(), events, data.prefs, settings.timezone, data.completed, now), events }, { headers: { 'Cache-Control': 'no-store' } });
}
export async function POST(request: Request) {
  const denied = await requireOwnerApi(); if (denied) return denied;
  if (!sameOrigin(request)) return Response.json({ error: '请从本站操作' }, { status: 403 });
  const { owner, db, data } = await state();
  const input = await request.json();
  if (input.prefs) {
    const p = input.prefs as AgendaPrefs;
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(p.start) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(p.end) || p.end <= p.start || !Number.isInteger(p.minutes) || p.minutes < 15 || p.minutes > 720) return Response.json({ error: '请设置同一天内的有效学习时段和 15–720 分钟预算' }, { status: 400 });
    data.prefs = { start: p.start, end: p.end, minutes: p.minutes, confirmed: true };
  }
  if (typeof input.completedId === 'string' && input.completedId.length < 500) data.completed = [...new Set([...data.completed, input.completedId])].slice(-2000);
  if (input.resetCompleted === true) data.completed = [];
  await db.prepare('INSERT INTO agenda_state(owner_id,payload) VALUES(?,?) ON CONFLICT(owner_id) DO UPDATE SET payload=excluded.payload').bind(owner, JSON.stringify(data)).run();
  return Response.json({ ok: true });
}
