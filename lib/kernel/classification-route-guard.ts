import {createHash}from'node:crypto';import type{Pool}from'pg';
import{planClassificationBranch}from'./classification-route-shadow.ts';
import{documentRoutingScopeSql,type DocumentRoutingScope}from'./document-routing-scope.ts';
type Scope={courseId?:string;documentId?:string;routingScope?:DocumentRoutingScope};
type Hit={document_id:string;page_number:number;source_version_id:string;evidence_id:string;source_hash:string};
const key=(h:Hit)=>JSON.stringify([h.document_id,h.page_number,h.source_version_id,h.evidence_id,h.source_hash]);
export type ClassificationGuardReceipt={version:'classification-guarded-lexical-v1';effect:'broad-fallback'|'lexical-narrowing';reason:string;
 plan:Awaited<ReturnType<typeof planClassificationBranch>>;outsideMatch:boolean|null;indexedMatchPages:number|null;baselineExecuted:boolean;branchExecuted:boolean;
 snapshot:'repeatable-read';semanticCoverage:'unassessed';filterAuthorization:false;scoredDocuments:null;scores:'original'|'branch-scope-bm25'};

/** Classification alone cannot exclude evidence. Independent index membership
 * must establish every lexical match fits in the proposed result set. No model,
 * body read or BM25 scoring occurs in this guard. It does not prove semantics. */
export async function runGuardedClassification<T extends Hit,O extends Scope>(pool:Pool,owner:string,query:string,options:O,
 spec:{broadQuery:string;limit:number},search:(db:Pool,o:O)=>Promise<T[]>){
 const client=await pool.connect(),db={query:client.query.bind(client)} as unknown as Pool;
 try{
  await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const plan=await planClassificationBranch(db,owner,query,options);
  let outsideMatch:boolean|null=null,indexedMatchPages:number|null=null,branchExecuted=false;
  const finish=(hits:T[],effect:ClassificationGuardReceipt['effect'],reason:string)=>{
   const receipt:ClassificationGuardReceipt={version:'classification-guarded-lexical-v1',effect,reason,plan,outsideMatch,indexedMatchPages,
    baselineExecuted:effect==='broad-fallback',branchExecuted,snapshot:'repeatable-read',semanticCoverage:'unassessed',filterAuthorization:false,scoredDocuments:null,
    scores:effect==='broad-fallback'?'original':'branch-scope-bm25'};
   return hits.map(h=>({...h,classification_route_guard:receipt}));
  };
  const broad=async(reason:string)=>finish(await search(db,options),'broad-fallback',reason);
  let result;
  if(plan.status!=='candidate'||!spec.broadQuery)result=await broad(plan.reason);
  else{
   const args:unknown[]=[owner,spec.broadQuery,options.courseId||null,options.documentId||null,plan.documentIds],where=documentRoutingScopeSql(options.routingScope,args),
    from=`FROM document_texts d JOIN document_text_versions v ON v.id=d.current_version_id AND v.document_id=d.id
     JOIN document_text_pages p ON p.version_id=v.id WHERE d.owner_id=$1 AND NOT d.hidden
     AND ($3::text IS NULL OR d.course_id=$3) AND ($4::text IS NULL OR d.id=$4) ${where}
     AND NOT EXISTS(SELECT 1 FROM document_texts newer WHERE newer.owner_id=d.owner_id AND newer.origin=d.origin AND newer.origin_key=d.origin_key
      AND NOT newer.hidden AND (newer.created_at>d.created_at OR (newer.created_at=d.created_at AND newer.id>d.id)))
     AND p.search_vector @@ (websearch_to_tsquery('english',$2)||websearch_to_tsquery('simple',$2))`;
   outsideMatch=Boolean((await client.query(`/* classifications:outside-index-guard */ SELECT EXISTS(SELECT 1 ${from} AND NOT(d.id=ANY($5::text[]))) outside`,args)).rows[0].outside);
   if(outsideMatch)result=await broad('outside-index-match');
   else{
    const bounded=[...args,spec.limit+1],proof=(await client.query<Hit>(`/* classifications:bounded-index-proof */
     SELECT d.id document_id,p.page_number,v.source_version_id,p.evidence_id,d.source_hash ${from} AND d.id=ANY($5::text[]) LIMIT $${bounded.length}`,bounded)).rows;
    indexedMatchPages=proof.length;
    if(proof.length>spec.limit)result=await broad('indexed-result-capacity');
    else{
     const prior=options.routingScope?.documentIds,ids=prior?plan.documentIds.filter(id=>prior.includes(id)):plan.documentIds;
     await client.query('SAVEPOINT classification_branch');let branch:T[]|null=null;
     try{branchExecuted=true;branch=await search(db,{...options,routingScope:{...options.routingScope,documentIds:ids}});await client.query('RELEASE SAVEPOINT classification_branch');}
     catch{await client.query('ROLLBACK TO SAVEPOINT classification_branch');await client.query('RELEASE SAVEPOINT classification_branch');}
     const expected=new Set(proof.map(key));
     result=branch&&branch.length===expected.size&&new Set(branch.map(key)).size===expected.size&&branch.every(h=>expected.has(key(h)))
      ?finish(branch,'lexical-narrowing','all-index-matches-returned'):await broad(branch?'indexed-evidence-mismatch':'branch-search-failed');
    }
   }
  }
  await client.query('COMMIT');return result;
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
export function classificationGuardAnswerObservation(hits:Array<Hit&{classification_route_guard?:ClassificationGuardReceipt}>){
 const receipts=new Map<string,ClassificationGuardReceipt>();
 for(const hit of hits)if(hit.classification_route_guard){const r=hit.classification_route_guard;receipts.set(createHash('sha256').update(JSON.stringify(r)).digest('hex'),r);}
 return receipts.size?{version:'classification-guarded-lexical-v1' as const,scope:'ranked-reader-returned-anchors-only' as const,receipts:[...receipts.values()]}:undefined;
}
