export type HealthDay = { date: string; steps: number | null; sleepMinutes: number | null; restingHeartRate: number | null; exerciseMinutes: number | null };
export function dateKey(date: any): string | null {
  if (!date?.year || !date.month || !date.day) return null;
  return `${date.year}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;
}
export function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value); return Number.isFinite(n) && n >= 0 ? n : null;
}
export function daysEnding(today: string, count = 7): HealthDay[] {
  return Array.from({ length: count }, (_, i) => ({ date: new Date(Date.parse(today + 'T12:00:00Z') - (count - 1 - i) * 86400000).toISOString().slice(0, 10), steps: null, sleepMinutes: null, restingHeartRate: null, exerciseMinutes: null }));
}
export function normalizeHealth(days: HealthDay[], payloads: Record<string, any>, timezone: string): HealthDay[] {
  const result = days.map(d => ({ ...d }));
  const byDate = new Map(result.map(d => [d.date, d]));
  const localDate = (interval: any) => dateKey(interval?.civilEndTime?.date) || (interval?.endTime ? new Date(interval.endTime).toLocaleDateString('en-CA', { timeZone: timezone }) : null);
  for (const point of payloads.steps?.rollupDataPoints || []) {
    const d = byDate.get(dateKey(point.civilStartTime?.date) || '');
    if (d) d.steps = numberOrNull(point.steps?.countSum);
  }
  for (const point of payloads.heart?.dataPoints || []) {
    const value = point.dailyRestingHeartRate;
    const d = byDate.get(dateKey(value?.date) || '');
    if (d) d.restingHeartRate = numberOrNull(value.beatsPerMinute);
  }
  const seen = new Set<string>();
  for (const point of payloads.sleep?.dataPoints || []) {
    const value = point.sleep;
    const d = byDate.get(localDate(value?.interval) || '');
    const minutes = numberOrNull(value?.summary?.minutesAsleep);
    const id = point.dataPointName || point.name || JSON.stringify(value?.interval);
    if (d && minutes !== null && !seen.has(id)) { d.sleepMinutes = (d.sleepMinutes ?? 0) + minutes; seen.add(id); }
  }
  for (const point of payloads.exercise?.dataPoints || []) {
    const interval = point.exercise?.interval;
    const d = byDate.get(localDate(interval) || '');
    const minutes = interval?.startTime && interval.endTime ? (Date.parse(interval.endTime) - Date.parse(interval.startTime)) / 60000 : NaN;
    const id = 'exercise:' + (point.dataPointName || point.name || JSON.stringify(interval));
    if (d && Number.isFinite(minutes) && minutes >= 0 && !seen.has(id)) { d.exerciseMinutes = (d.exerciseMinutes ?? 0) + Math.round(minutes); seen.add(id); }
  }
  return result;
}
