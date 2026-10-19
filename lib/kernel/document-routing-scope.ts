import type {Pool} from 'pg';

const dimensions=['courseIds','documentIds','origins','termIds'] as const;
export type DocumentRoutingScope=Readonly<Partial<Record<typeof dimensions[number],readonly string[]>>>;
type LegacyScope={courseId?:string;documentId?:string;routingScope?:DocumentRoutingScope};

/** Explicit caller scope only. Inferred topics/types cannot enter this contract.
 * Dimensions intersect; values within a dimension form a union; [] matches none. */
export function normalizeDocumentRoutingScope(value:unknown):DocumentRoutingScope|undefined{
 if(value===undefined)return undefined;
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!dimensions.includes(key as typeof dimensions[number])))
  throw Error('Invalid explicit document routing scope');
 const out:Partial<Record<typeof dimensions[number],readonly string[]>>={};
 for(const key of dimensions){
  if(!Object.hasOwn(value,key))continue;
  const items=(value as Record<string,unknown>)[key];
  if(!Array.isArray(items)||items.length>256||items.some(item=>typeof item!=='string'||!item.trim()||item.length>4000||item.includes('\0')))
   throw Error('Invalid explicit document routing values');
  out[key]=Object.freeze([...new Set(items)]);
 }
 return Object.freeze(out);
}

/** Same parameterized predicate for lexical, vector, title and supplement SQL.
 * Every caller still enforces owner/current-source guards. No tag inference. */
export function documentRoutingScopeSql(value:DocumentRoutingScope|undefined,args:unknown[]):string{
 const scope=normalizeDocumentRoutingScope(value);if(!scope)return '';
 if(Object.values(scope).some(items=>items!.length===0))return 'AND FALSE';
 return dimensions.filter(key=>scope[key]!==undefined).map(key=>{
  const parameter=args.push(scope[key]);
  return key==='termIds'?`AND EXISTS(SELECT 1 FROM courses scope_course WHERE scope_course.id=d.course_id AND scope_course.term_id=ANY($${parameter}::text[]))`:
   `AND d.${{courseIds:'course_id',documentIds:'id',origins:'origin'}[key]}=ANY($${parameter}::text[])`;
 }).join(' ');
}

const currentSource=`NOT EXISTS(SELECT 1 FROM document_texts newer WHERE newer.owner_id=d.owner_id
 AND newer.origin=d.origin AND newer.origin_key=d.origin_key AND NOT newer.hidden
 AND (newer.created_at>d.created_at OR (newer.created_at=d.created_at AND newer.id>d.id)))`;

/** Recheck scope after expansion/fallback, including changes to course terms.
 * Unscoped legacy requests add no query. Source hashes are checked by readers. */
export async function assertDocumentRoutingScope(pool:Pool,owner:string,documentIds:readonly string[],scope:LegacyScope){
 const routingScope=normalizeDocumentRoutingScope(scope.routingScope);if(!routingScope)return;
 const ids=[...new Set(documentIds)];if(!ids.length)return;
 if(!owner||ids.length>512)throw Error('Invalid scoped document recheck');
 const args:unknown[]=[owner,ids,scope.courseId||null,scope.documentId||null],where=documentRoutingScopeSql(routingScope,args);
 const n=(await pool.query(`SELECT count(*)::int n FROM document_texts d
  JOIN document_text_versions v ON v.id=d.current_version_id AND v.document_id=d.id
  WHERE d.owner_id=$1 AND d.id=ANY($2::text[]) AND NOT d.hidden
   AND ($3::text IS NULL OR d.course_id=$3) AND ($4::text IS NULL OR d.id=$4)
   AND ${currentSource} ${where}`,args)).rows[0].n;
 if(Number(n)!==ids.length)throw Error('Document evidence left the explicit routing scope');
}

/** Count current permission-eligible files/pages before and after scope only.
 * These are candidate counts, not ranked/scored work or a relevance score. */
export async function documentRoutingScopeCounts(pool:Pool,owner:string,scope:LegacyScope={}){
 if(!owner?.trim())throw Error('Document routing owner is required');
 const args:unknown[]=[owner,scope.courseId||null,scope.documentId||null],where=documentRoutingScopeSql(scope.routingScope,args);
 const row=(await pool.query(`WITH visible AS MATERIALIZED(
  SELECT d.* FROM document_texts d JOIN document_text_versions v ON v.id=d.current_version_id AND v.document_id=d.id
  WHERE d.owner_id=$1 AND NOT d.hidden AND ${currentSource}),routed AS MATERIALIZED(
   SELECT d.* FROM visible d WHERE ($2::text IS NULL OR d.course_id=$2) AND ($3::text IS NULL OR d.id=$3) ${where})
  SELECT (SELECT count(*) FROM visible)::int eligible_documents,(SELECT count(*) FROM routed)::int routed_documents,
   (SELECT count(*) FROM document_text_pages p JOIN visible d ON d.current_version_id=p.version_id)::int eligible_pages,
   (SELECT count(*) FROM document_text_pages p JOIN routed d ON d.current_version_id=p.version_id)::int routed_pages`,args)).rows[0];
 return {eligibleDocuments:Number(row.eligible_documents),routedDocuments:Number(row.routed_documents),
  eligiblePages:Number(row.eligible_pages),routedPages:Number(row.routed_pages)};
}
