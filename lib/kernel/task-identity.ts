import type { CanvasSource } from '../domain.ts';

export type CanvasTaskReference = { type: 'assignment' | 'quiz' | 'discussion' | 'page'; id: string };

const plannerTypes: Record<string, CanvasTaskReference['type']> = {
  assignment: 'assignment', quiz: 'quiz', discussion_topic: 'discussion', wiki_page: 'page',
};

function validId(value: unknown): string | null {
  const id = String(value ?? '');
  return /^[1-9]\d*$/.test(id) ? id : null;
}

/** Only Canvas's explicit typed planner reference proves equivalence. */
export function canvasTaskReference(source: CanvasSource): CanvasTaskReference | null {
  if (source.sourceType !== 'planner') {
    const type = plannerTypes[source.sourceType];
    const id = validId(source.sourceId);
    return type && id ? { type, id } : null;
  }
  const type = plannerTypes[String(source.plannableType ?? '').toLowerCase()];
  const id = validId(source.plannableId);
  return type && id ? { type, id } : null;
}

export function canvasTaskIdentity(source: CanvasSource, index: number): string {
  const ref = canvasTaskReference(source);
  return ref ? `${source.courseId}|canvas:${ref.type}:${ref.id}|${index}`
    : `${source.courseId}|${source.sourceType}|${source.sourceId}|${index}`;
}
