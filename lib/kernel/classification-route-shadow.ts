import {createHash} from 'node:crypto';
import type {Pool} from 'pg';
import {contentTagQueryPlan} from './content-tag-routing.ts';
import {validateStoredContentClassification} from './content-classifications.ts';
import {documentRoutingScopeSql,type DocumentRoutingScope} from './document-routing-scope.ts';

const normalize=(s:string)=>s.normalize('NFKC').toLowerCase().trim().replace(/\s+/gu,' '),
 sha=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export function literalClassificationMention(query:string,key:string){
 const q=normalize(query),k=normalize(key);if(!k)return false;
 for(let at=q.indexOf(k);at>=0;at=q.indexOf(k,at+1)){
  const left=Array.from(q.slice(0,at)).at(-1)??'',right=Array.from(q.slice(at+k.length))[0]??'';
  const first=Array.from(k)[0],last=Array.from(k).at(-1)!;
  if((/\p{Script=Han}/u.test(first)||!/[\p{L}\p{N}_]/u.test(left))&&
   (/\p{Script=Han}/u.test(last)||!/[\p{L}\p{N}_]/u.test(right)))return true;
 }
 return false;
}
type Scope={courseId?:string;documentId?:string;routingScope?:DocumentRoutingScope};
type Plan={status:'candidate'|'broad';reason:string;documentIds:string[];classificationIds:string[];querySha256:string};

/** Read current classification metadata only, never original bodies/vectors.
 * Literal hints propose an experimental branch, not permission to exclude. */
export async function planClassificationBranch(pool:Pool,owner:string,query:string,scope:Scope):Promise<Plan>{
 if(typeof query!=='string'||!query.trim()||query.length>16000||!owner?.trim())throw Error('Invalid classification routing query');
 const hints=contentTagQueryPlan(query).hints.map(({facet,key})=>({facet,key})),normalized=normalize(query),
  args:unknown[]=[owner,normalized,JSON.stringify(hints),scope.courseId||null,scope.documentId||null],where=documentRoutingScopeSql(scope.routingScope,args),
  result=(status:Plan['status'],reason:string,documentIds:string[]=[],classificationIds:string[]=[]):Plan=>({status,reason,documentIds,classificationIds,querySha256:sha(query)});
 const rows=(await pool.query<Record<string,unknown>>(`/* classifications:shadow-plan */ SELECT r.* FROM document_content_classification_heads h
  JOIN document_content_classifications r ON r.id=h.classification_id AND r.owner_id=h.owner_id AND r.version_id=h.version_id AND r.classifier_id=h.classifier_id
  JOIN document_texts d ON d.id=r.document_id AND d.owner_id=r.owner_id AND d.current_version_id=r.version_id AND d.source_hash=r.source_hash
  WHERE d.owner_id=$1 AND NOT d.hidden AND ($4::text IS NULL OR d.course_id=$4) AND ($5::text IS NULL OR d.id=$5) ${where}
   AND NOT EXISTS(SELECT 1 FROM document_texts newer WHERE newer.owner_id=d.owner_id AND newer.origin=d.origin AND newer.origin_key=d.origin_key
    AND NOT newer.hidden AND (newer.created_at>d.created_at OR (newer.created_at=d.created_at AND newer.id>d.id)))
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(r.assignments) a WHERE
    (a->>'facet' IN ('topic','chapter') AND length(a->>'key')>0 AND strpos($2,a->>'key')>0)
    OR EXISTS(SELECT 1 FROM jsonb_to_recordset($3::jsonb) AS hint(facet text,key text) WHERE a->>'facet'=hint.facet AND a->>'key'=hint.key))
  ORDER BY r.id LIMIT 257`,args)).rows;
 if(rows.length>256)return result('broad','classification-capacity');
 const matched=[];
 for(const row of rows){
  let input;try{input=validateStoredContentClassification(row);}catch{return result('broad','invalid-classification');}
  if(input.tags.some(t=>hints.some(h=>h.facet===t.facet&&h.key===t.key)||
   ['topic','chapter'].includes(t.facet)&&literalClassificationMention(query,t.key)))matched.push({documentId:input.documentId,id:String(row.id)});
 }
 const ids=[...new Set(matched.map(m=>m.documentId))].sort();
 if(!ids.length)return result('broad','no-literal-classification');
 if(ids.length>128)return result('broad','candidate-capacity');
 return result('candidate','literal-classification-proposal',ids,matched.map(m=>m.id).sort());
}
type Hit={document_id:string;page_number:number;source_version_id:string;evidence_id:string;source_hash:string};
const identity=(h:Hit)=>JSON.stringify([h.document_id,h.page_number,h.source_version_id,h.evidence_id,h.source_hash]);
export type ClassificationRouteShadow={version:'classification-shadow-v1';effect:'observe-only';filterAuthorization:false;semanticVerified:false;
 plan:Plan;baselineReturned:number;branchExecuted:boolean;branchReturned:number|null;baselineEvidenceMissingFromBranch:number|null;branchError:string|null;scoredDocuments:null};

/** Always preserve the baseline. Missing baseline evidence is a routing loss
 * diagnostic, not a Gold score. This shadow mode saves no total query work. */
export async function runClassificationShadow<T extends Hit,O extends Scope>(pool:Pool,owner:string,query:string,options:O,search:(o:O)=>Promise<T[]>){
 const plan=await planClassificationBranch(pool,owner,query,options),baseline=await search(options);
 let branch:T[]=[],branchError:string|null=null;
 const prior=options.routingScope?.documentIds,ids=prior?plan.documentIds.filter(id=>prior.includes(id)):plan.documentIds;
 if(plan.status==='candidate')try{branch=await search({...options,routingScope:{...options.routingScope,documentIds:ids}});}
 catch{branchError='branch-search-failed';}
 const found=new Set(branch.map(identity)),receipt:ClassificationRouteShadow={version:'classification-shadow-v1',effect:'observe-only',filterAuthorization:false,semanticVerified:false,
  plan,baselineReturned:baseline.length,branchExecuted:plan.status==='candidate',branchReturned:plan.status==='candidate'?branch.length:null,
  baselineEvidenceMissingFromBranch:plan.status==='candidate'?baseline.filter(h=>!found.has(identity(h))).length:null,branchError,scoredDocuments:null};
 return baseline.map(hit=>({...hit,classification_route_shadow:receipt}));
}

export function classificationShadowAnswerObservation(hits:Array<Hit&{classification_route_shadow?:ClassificationRouteShadow}>){
 const receipts=new Map<string,ClassificationRouteShadow>();
 for(const hit of hits)if(hit.classification_route_shadow){const receipt=hit.classification_route_shadow;receipts.set(sha(receipt),receipt);}
 return receipts.size?{version:'classification-shadow-v1' as const,scope:'ranked-reader-returned-anchors-only' as const,effect:'observe-only' as const,receipts:[...receipts.values()]}:undefined;
}
