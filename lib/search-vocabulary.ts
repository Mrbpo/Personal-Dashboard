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

export function asksOnlyForPiazza(question: string): boolean {
  if (!/piazza/i.test(question)) return false;
  if (/\b(?:canvas|assignment|lecture|pdf|syllabus|email|alongside|together|using)\b|课件|课程大纲|作业说明|邮件|结合|综合|以及|和\s*piazza/i.test(question)) return false;
  return /(?:只|仅|only).{0,12}piazza|piazza.{0,12}(?:帖子|讨论|问答)|^(?:总结|汇总|概览|查看|查找|搜索|检索).{0,20}piazza\s*$/i.test(question);
}

export function requestedCourseCodes(question: string, codes: string[]): string[] {
  const known = new Set(codes.map(code => code.toUpperCase().replace(/\s/g, '').replace(/H\d$/, '')));
  return (question.match(/[A-Za-z]{2,}\s*\d{2,}(?:[Hh]\d)?/g) || [])
    .filter(raw => {
      const code = raw.toUpperCase().replace(/\s/g, '').replace(/H\d$/, '');
      // Unknown but explicitly capitalized codes still constrain a search to
      // zero matches. Ordinary text such as "page 413" must not do so.
      return known.has(code) || /^[A-Z]{2,}\d{2,}(?:H\d)?$/.test(raw);
    })
    .map(raw => raw.toUpperCase().replace(/\s/g, '').replace(/H\d$/, ''));
}

export function asksForCourseIdentity(question: string): boolean {
  return /我的课程|哪些课程|课程.{0,8}(?:叫什么|名称|代码)|是什么课程|学期|list.{0,12}courses?|which courses?|what course|\bterm\b/i.test(question);
}

export function asksForEventTiming(question: string): boolean {
  return /日程|日历|\bcalendar\b|\bevent\b|\bschedule\b|考试.{0,12}(?:时间|日期|几点|几号|何时|什么时候|安排)|(?:时间|日期|几点|几号|何时|什么时候).{0,12}考试|(?:when|date|time).{0,40}(?:midterm|final\s+exam)|(?:midterm|final\s+exam).{0,40}(?:when|date|time)/i.test(question);
}

export function ftsMatchTerms(terms: string[]): string {
  return [...new Set(terms.map((term) => term.trim().toLocaleLowerCase()))]
    .filter((term) => term.length >= 2 && !/^\d+$/.test(term))
    .slice(0, 20)
    .map((term) => `"${term.replaceAll('"', '""')}"`)
    .join(' OR ');
}
