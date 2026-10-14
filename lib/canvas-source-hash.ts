import type { CanvasSource } from './domain.ts';

/** Keep historical backfill and regular Canvas scans on the same source-version key. */
export async function hashSource(source: CanvasSource): Promise<string> {
  const payload = JSON.stringify({
    title: source.title,
    body: source.body,
    sourceUrl: source.sourceUrl,
    plannableType: source.plannableType ?? null,
    plannableId: source.plannableId ?? null,
    plannerItemId: source.plannerItemId ?? null,
    plannerContextCode: source.plannerContextCode ?? null,
    plannerCourseId: source.plannerCourseId ?? null,
    dueAt: source.dueAt,
    unlockAt: source.unlockAt,
    lockAt: source.lockAt,
    submissionState: source.submissionState,
    pointsPossible: source.pointsPossible,
    prerequisiteBlocked: source.prerequisiteBlocked,
    file: source.file ? { name: source.file.name, size: source.file.size } : null,
    folderPath: source.folderPath ?? null,
  });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, '0')).join('');
}
