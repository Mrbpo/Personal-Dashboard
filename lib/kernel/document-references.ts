import type {Pool} from 'pg';
import {documentRoutingScopeSql,type DocumentRoutingScope} from './document-routing-scope.ts';
import type {DocumentTextHit} from './document-search.ts';

const normalize=(text:string)=>text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').replace(/\s+/gu,' ').trim();
const identity=(hit:DocumentTextHit)=>`${hit.document_id}:${hit.page_number}:${hit.source_version_id}:${hit.evidence_id}`;

/** Explicit names are retrieval hints, never canonical entity merges or facts. */
export function documentTitleAliases(name:string):string[]{
 const clean=name.replace(/(?:\.(?:pdf|txt|docx?|pptx?|html?|md))+$/iu,'').trim();
 const base=clean.replace(/\s*\([^()]*\)\s*$/u,'').trim();
 const numbered=base.match(/^[\p{L}]+\d+[\p{L}\d]*\b/u)?.[0];
 return [...new Set([clean,base,...(numbered?[numbered]:[])].map(normalize))]
  .filter(alias=>alias.length>=4||(/^[\p{L}]+\d+[\p{L}\d]*$/u.test(alias)&&alias.length>=3));
}

// A lowercase common word in a question is not evidence that its namesake
// document was requested. Keep short explicit names without treating every
// ordinary noun as a title. Multiword titles and numbered identifiers retain
// the whole-phrase match; CJK titles do not require letter case.
function explicitSingleNames(texts:string[]):string[]{
 const names=texts.flatMap(text=>[
  ...[...text.normalize('NFKC').matchAll(/(?:^|[^\p{L}\p{N}])([\p{Lu}][\p{L}\p{N}]{3,})(?=$|[^\p{L}\p{N}])/gu)].map(match=>normalize(match[1])),
  ...[...text.matchAll(/["“「『]([^"”」』]+)["”」』]/gu)].map(match=>normalize(match[1]))]);
 return [...new Set(names)];
}

export function mergeReferencedEvidence(base:DocumentTextHit[],direct:DocumentTextHit[],related:DocumentTextHit[],limit:number):DocumentTextHit[]{
 const out:DocumentTextHit[]=[],seen=new Set<string>();
 const add=(hit:DocumentTextHit)=>{const key=identity(hit);if(!seen.has(key)&&out.length<limit){seen.add(key);out.push(hit);}};
 // Protect explicit query subjects and retain the keyword head. Every added
 // page was independently read from current owner/course-scoped PG evidence.
 direct.slice(0,4).forEach(add);base.slice(0,3).forEach(add);
 related.slice(0,Math.max(1,Math.floor(limit/2))).forEach(add);
 base.forEach(add);direct.forEach(add);related.forEach(add);
 return out.map((hit,index)=>({...hit,score:1/(index+1),retrieval_mode:'keyword' as const}));
}

async function references(pool:Pool,owner:string,query:string,texts:string[],seedAliases:string[],courseId?:string,routingScope?:DocumentRoutingScope):Promise<DocumentTextHit[]>{
 if(!texts.length&&!seedAliases.length)return [];
 const normalizedTexts=texts.map(normalize);
 const words=[...new Set(normalizedTexts.flatMap(value=>value.split(' ')))];
 const args:unknown[]=[owner,normalize(query).split(' ').filter(word=>word.length>=2).slice(0,40).map(word=>`"${word}"`).join(' OR '),
  normalizedTexts,seedAliases,courseId||null,explicitSingleNames(texts),words],routing=documentRoutingScopeSql(routingScope,args);
 // Metadata matching is bounded; no vector JSON or full corpus bodies leave PG.
 const rows=await pool.query<DocumentTextHit>(`WITH current_docs AS MATERIALIZED (
  SELECT d.*,v.id version_id,v.source_version_id,v.parser_version,v.warnings FROM document_texts d
  JOIN document_text_versions v ON v.id=d.current_version_id
  WHERE d.owner_id=$1 AND NOT d.hidden AND ($5::text IS NULL OR d.course_id=$5) ${routing}
   AND NOT EXISTS (SELECT 1 FROM document_texts newer WHERE newer.owner_id=d.owner_id AND newer.origin=d.origin
     AND newer.origin_key=d.origin_key AND NOT newer.hidden
     AND (newer.created_at>d.created_at OR (newer.created_at=d.created_at AND newer.id>d.id)))),
 names AS (SELECT d.*,regexp_replace(d.name,'(\\.(pdf|txt|docx?|pptx?|html?|md))+$','','i') clean FROM current_docs d),
 aliases AS (SELECT d.*,trim(regexp_replace(lower(normalize(a.value,NFKC)),'[^[:alnum:]]+',' ','g')) alias
  FROM names d CROSS JOIN LATERAL unnest(ARRAY[d.clean,regexp_replace(d.clean,'\\s*\\([^()]*\\)\\s*$',''),
   substring(d.clean FROM '^([[:alpha:]]+[[:digit:]]+[[:alnum:]]*)\\y')]) a(value)),
 matched AS (SELECT id,max(length(alias)) specificity FROM aliases a
  WHERE (length(alias)>=4 OR (length(alias)>=3 AND alias~'^[[:alpha:]]+[[:digit:]]+[[:alnum:]]*$'))
   AND (strpos(alias,' ')>0 OR alias~'[[:digit:]]' OR alias=ANY($6::text[]) OR alias~'[一-鿿]') AND
   ((split_part(alias,' ',1)=ANY($7::text[]) AND
      EXISTS (SELECT 1 FROM unnest($3::text[]) t(value) WHERE strpos(' '||t.value||' ',' '||alias||' ')>0))
    OR EXISTS (SELECT 1 FROM unnest($4::text[]) s(value) WHERE strpos(' '||alias||' ',' '||s.value||' ')>0))
  GROUP BY id),q AS (SELECT websearch_to_tsquery('english',$2)||websearch_to_tsquery('simple',$2) query),
 choices AS (SELECT d.*,m.specificity,p.page_number,p.body,p.locator,p.evidence_id,p.content_kind,p.start_ms,p.end_ms,
   ts_rank_cd(p.search_vector,q.query,0) relevance,
   row_number() OVER(PARTITION BY d.id ORDER BY ts_rank_cd(p.search_vector,q.query,0) DESC,p.page_number) choice
  FROM matched m JOIN current_docs d ON d.id=m.id JOIN document_text_pages p ON p.version_id=d.version_id
  JOIN evidence e ON e.id=p.evidence_id AND e.source_version_id=d.source_version_id CROSS JOIN q)
 SELECT 'pg:'||version_id||':'||page_number id,id document_id,coalesce(course_id,'') course_id,name,origin,origin_key,
  source_hash,body,locator,page_number,evidence_id,source_version_id,parser_version,warnings parser_warnings,
  content_kind,start_ms::double precision,end_ms::double precision,relevance score
 FROM choices WHERE choice=1 ORDER BY relevance DESC,specificity DESC,id LIMIT 24`,
 args);
 return rows.rows.map(row=>({...row,score:Number(row.score),retrieval_mode:'keyword' as const}));
}

/** Two bounded title/mention hops. Text is data, not instructions; references
 * preserve distinct documents and make no state changes or external calls. */
export async function recallReferencedDocuments(pool:Pool,owner:string,query:string,base:DocumentTextHit[],limit:number,courseId?:string,routingScope?:DocumentRoutingScope){
 const direct=await references(pool,owner,query,[query],[],courseId,routingScope);
 const seeds=[...direct.slice(0,4),...base.slice(0,3)];
 const unique=new Map(seeds.map(hit=>[hit.document_id,hit]));
 const selected=[...unique.values()].slice(0,4);
 const related=await references(pool,owner,query,selected.map(hit=>hit.body.slice(0,6000)),
  selected.flatMap(hit=>documentTitleAliases(hit.name)),courseId,routingScope);
 const ordered=mergeReferencedEvidence(base,direct,related,Math.max(limit,base.length+direct.length+related.length));
 const args:unknown[]=[owner,JSON.stringify(ordered.map(hit=>({document_id:hit.document_id,page_number:hit.page_number,
  source_version_id:hit.source_version_id,evidence_id:hit.evidence_id}))),courseId||null],routing=documentRoutingScopeSql(routingScope,args);
 const current=(await pool.query<{evidence_id:string}>(`WITH requested AS (SELECT * FROM jsonb_to_recordset($2::jsonb)
   AS r(document_id text,page_number integer,source_version_id text,evidence_id text))
  SELECT p.evidence_id FROM requested r JOIN document_texts d ON d.id=r.document_id AND d.owner_id=$1 AND NOT d.hidden
  JOIN document_text_versions v ON v.id=d.current_version_id AND v.source_version_id=r.source_version_id
  JOIN document_text_pages p ON p.version_id=v.id AND p.page_number=r.page_number AND p.evidence_id=r.evidence_id
  JOIN evidence e ON e.id=p.evidence_id AND e.source_version_id=v.source_version_id
  WHERE ($3::text IS NULL OR d.course_id=$3) ${routing} AND NOT EXISTS (SELECT 1 FROM document_texts newer
   WHERE newer.owner_id=d.owner_id AND newer.origin=d.origin AND newer.origin_key=d.origin_key AND NOT newer.hidden
    AND (newer.created_at>d.created_at OR (newer.created_at=d.created_at AND newer.id>d.id)))`,
  args)).rows;
 const verified=new Set(current.map(row=>row.evidence_id));
 return ordered.filter(hit=>verified.has(hit.evidence_id)).slice(0,limit);
}
