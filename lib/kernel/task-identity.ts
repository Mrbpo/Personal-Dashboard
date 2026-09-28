import type { CanvasSource } from '../domain.ts';

export type CanvasTaskReference = { type: 'assignment' | 'quiz' | 'discussion' | 'page'; id: string };

const plannerTypes: Record<string, CanvasTaskReference['type']> = {
  assignment: 'assignment', quiz: 'quiz', discussion_topic: 'discussion', wiki_page: 'page',
};

function validId(value: unknown): string | null {
  const id = String(value ?? '');
  return /^[1-9]\d*$/.test(id) ? id : null;
}

function urlReference(source: CanvasSource): CanvasTaskReference | null {
  if (!source.sourceUrl) return null;
  try {
    const url = new URL(source.sourceUrl);
    const match = /^\/courses\/([^/]+)\/(assignments|quizzes|discussion_topics|pages)\/([^/]+)\/?$/.exec(url.pathname);
    if (!match || match[1] !== source.courseId) return null;
    const type = plannerTypes[({ assignments: 'assignment', quizzes: 'quiz', discussion_topics: 'discussion_topic', pages: 'wiki_page' } as Record<string,string>)[match[2]]];
    const id = validId(match[3]);
    return type && id ? { type, id } : null;
  } catch { return null; }
}

/** Only Canvas's typed reference or an exact Canvas course URL proves equivalence. */
export function canvasTaskReference(source: CanvasSource): CanvasTaskReference | null {
  if (source.sourceType !== 'planner') {
    const type = plannerTypes[source.sourceType];
    const id = validId(source.sourceId);
    return type && id ? { type, id } : null;
  }
  const type = plannerTypes[String(source.plannableType ?? '').toLowerCase()];
  const id = validId(source.plannableId);
  const fromUrl = urlReference(source);
  if (type && id) {
    if (fromUrl && (fromUrl.type !== type || fromUrl.id !== id)) return null;
    return { type, id };
  }
  return !source.plannableType && !source.plannableId ? fromUrl : null;
}

export function canvasTaskIdentity(source: CanvasSource, index: number): string {
  const ref = canvasTaskReference(source);
  return ref ? `${source.courseId}|canvas:${ref.type}:${ref.id}|${index}`
    : `${source.courseId}|${source.sourceType}|${source.sourceId}|${index}`;
}
