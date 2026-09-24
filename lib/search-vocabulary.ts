// Conditional bilingual aliases for activities named differently by students
// and in Canvas or Piazza. General questions must not match every lab.
export function activitySearchAliases(question: string): string[] {
  const aliases = new Set<string>();
  const lab = /实验|\blab(?:oratory)?\b/i.test(question);
  if (lab) ['lab', 'laboratory', '实验'].forEach((word) => aliases.add(word));
  if (lab && /要求|准备|instructions?|requirements?|怎么做|如何做|what.*(?:do|need)/i.test(question))
    ['instruction', 'requirement', 'lab instruction', 'lab requirement'].forEach((word) => aliases.add(word));
  if (/课前|pre.?lab|before\s+lab/i.test(question))
    ['prelab', 'before lab', '课前'].forEach((word) => aliases.add(word));
  if (/notebook|实验记录|实验本/i.test(question))
    ['notebook', 'lab notebook', '实验记录', '实验本'].forEach((word) => aliases.add(word));
  return [...aliases];
}

export function asksForSyllabus(question: string): boolean {
  return /课程大纲|教学大纲|\bsyllabus\b|\bcourse\s+outline\b/i.test(question);
}

export function ftsMatchTerms(terms: string[]): string {
  return [...new Set(terms.map((term) => term.trim().toLocaleLowerCase()))]
    .filter((term) => term.length >= 2 && !/^\d+$/.test(term))
    .slice(0, 20)
    .map((term) => `"${term.replaceAll('"', '""')}"`)
    .join(' OR ');
}
