import {createHash} from 'node:crypto';

export const QUESTION_COURSE_ROUTING_VERSION='explicit-course-code-route-v1';
type Course={id:string;code:string;enabled?:boolean};
type Observation={raw:string;code:string;startUtf16:number;endUtf16:number;courseIds:string[]};
export type QuestionCourseRoute={version:typeof QUESTION_COURSE_ROUTING_VERSION;catalogSha256:string;
 status:'resolved'|'unresolved'|'broad'|'none';reason:string;courseIds:string[];observations:Observation[];
 inputOrigin?:'successful-history';fromMessageId?:string;scopeApplied?:boolean;
 retainedUnmappedSources?:true;excludedCourseIds?:string[];
 fallbackReason?:'unassigned-or-unmapped-source'|'course-catalog-capacity'|'course-exclusion-capacity'};
const tokens=(text:string)=>[...text.matchAll(/(?<![a-z0-9])([a-z]{2,8} ?\d{1,3}[-.]\d{2,4}|[a-z]{2,8}[ -]?\d{2,4}(?:[hyfs]\d)?)(?![a-z0-9]|[-.]\d)/gi)],
 key=(value:string)=>/\d[-.]\d/.test(value)?value.toUpperCase().replace(/ /g,''):value.toUpperCase().replace(/[ -]/g,''),
 base=(value:string)=>value.replace(/[HYFS]\d$/,'');

/** Exact original spans. A mention does not establish document course ownership. */
export function observeLiteralCourseCodes(text:string){
 if(typeof text!=='string'||text.length>32768)throw Error('Invalid literal course-code text');
 return tokens(text).map(match=>({raw:match[0],code:key(match[0]),startUtf16:match.index!,endUtf16:match.index!+match[0].length}));
}

/** A bounded observation of literal course codes, not semantic classification.
 * Keep all canonical matches/terms; never elect the first or latest course.
 * Unknown, exclusion and broader-scope intent cannot become an exclusive set. */
export function routeQuestionCourseCodes(question:string,courses:readonly Course[]):QuestionCourseRoute{
 if(typeof question!=='string'||question.length>6000||courses.length>10000)throw Error('Invalid course routing input');
 const catalog=courses.filter(c=>c.enabled!==false).map(c=>({id:c.id,code:c.code})).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0),
  catalogSha256=createHash('sha256').update(JSON.stringify(catalog)).digest('hex'),
  known=catalog.flatMap(c=>{const token=tokens(c.code)[0];return token?[{id:c.id,code:key(token[0])}]:[];}),
  observations=observeLiteralCourseCodes(question).map(observation=>{
   const {code}=observation,full=base(code)!==code;
   return {...observation,
    courseIds:[...new Set(known.filter(c=>full?c.code===code:base(c.code)===code).map(c=>c.id))].sort()};
  }),courseIds=[...new Set(observations.flatMap(o=>o.courseIds))].sort();
 const result=(status:QuestionCourseRoute['status'],reason:string,ids:string[]=[]):QuestionCourseRoute=>({
  version:QUESTION_COURSE_ROUTING_VERSION,catalogSha256,status,reason,courseIds:ids,observations});
 const broader=[...question.matchAll(/所有课程|全部课程|跨所有课程|其他课程|其它课程|\b(?:all|other|across)\s+(?:my\s+)?courses\b/gi)];
 if(broader.some(m=>!/(?:\b(?:no|not|without)|不要|不含|没有)\s*$/i.test(question.slice(0,m.index))))
  return result('broad','explicit-broader-course-scope');
 if(!observations.length)return result('none','no-literal-course-code');
 if(observations.some(o=>/(?:\b(?:not|except(?: for)?|exclude|excluding|without|instead of|rather than|avoid|don't(?: use| search)?|do not(?: use| search)?)|不是|不要(?:用|搜|检索)?|不包括|排除|除了)\s*(?:the\s+)?(?:course\s+)?$/i
  .test(question.slice(0,o.startUtf16))||/^\s*(?:除外|以外|之外)/.test(question.slice(o.endUtf16))))
  return result('unresolved','course-exclusion-needs-interpretation');
 if(observations.some(o=>o.courseIds.length===0))return result('unresolved','unrecognized-course-code');
 if(courseIds.length>256)return result('unresolved','course-scope-capacity');
 return result('resolved','all-literal-code-matches',courseIds);
}
