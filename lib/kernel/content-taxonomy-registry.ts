import{createHash}from'node:crypto';import type{Pool,PoolClient}from'pg';
import{literalTaxonomyMention}from'./content-taxonomy.ts';

export const CONTENT_TOPIC_TAXONOMY_VERSION='academic-topic-taxonomy-v1';
export type TaxonomyEntry={facet:'topic'|'chapter';key:string;aliases:string[]};
type Request={previousId:string|null;entries:TaxonomyEntry[]};
type DB=Pick<Pool,'query'>|Pick<PoolClient,'query'>;
const canonical=(v:unknown)=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x),
 hash=(v:unknown)=>createHash('sha256').update(canonical(v)).digest('hex'),normalize=(s:string)=>s.normalize('NFKC').toLowerCase().trim().replace(/\s+/gu,' '),
 hex=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v),
 text=(v:unknown,max=240):v is string=>typeof v==='string'&&!!v.trim()&&v.length<=max&&!v.includes('\0'),
 exact=(v:unknown,keys:string[])=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));

/** Administrator-authored configuration only; no invented source document,
 * source excerpt, academic fact or claim of semantic/filter authority. */
export function validateContentTaxonomy(input:unknown):Request{
 if(!exact(input,['previousId','entries'])||Buffer.byteLength(JSON.stringify(input))>65536)throw Error('Invalid bounded taxonomy request');
 const v=structuredClone(input)as Request;
 if(!(v.previousId===null||hex(v.previousId))||!Array.isArray(v.entries)||v.entries.length>256)throw Error('Invalid taxonomy revision');
 const seen=new Set<string>();
 for(const e of v.entries){
  if(!exact(e,['facet','key','aliases'])||!['topic','chapter'].includes(e.facet)||!text(e.key)||!Array.isArray(e.aliases)||e.aliases.length>16||
   e.aliases.some(a=>!text(a)||a!==a.trim()))throw Error('Invalid taxonomy entry');
  e.key=normalize(e.key);const k=canonical([e.facet,e.key]);
  if(seen.has(k)||new Set(e.aliases.map(normalize)).size!==e.aliases.length)throw Error('Duplicate taxonomy key/alias');seen.add(k);
 }
 return v;
}
export function validateStoredContentTaxonomy(row:Record<string,unknown>){
 if(row.taxonomy_version!==CONTENT_TOPIC_TAXONOMY_VERSION||row.semantic_verified!==false||row.filter_authorization!==false||
  !text(row.owner_id,4000)||!text(row.actor)||!text(row.reason,2000))throw Error('Invalid stored taxonomy authority');
 const request=validateContentTaxonomy(row.request);
 if(request.previousId!==row.previous_id||canonical(request)!==canonical(row.request)||row.input_sha256!==hash(request)||
  row.id!==hash({owner:row.owner_id,version:CONTENT_TOPIC_TAXONOMY_VERSION,request,actor:row.actor,reason:row.reason}))throw Error('Taxonomy revision digest differs');
 return request;
}
export async function readContentTaxonomy(db:DB,owner:string){
 if(!text(owner,4000))throw Error('Taxonomy owner required');
 const row=(await db.query(`SELECT r.* FROM content_taxonomy_heads h JOIN content_taxonomy_revisions r
  ON r.owner_id=h.owner_id AND r.id=h.revision_id WHERE h.owner_id=$1`,[owner])).rows[0];
 if(!row)return null;
 const request=validateStoredContentTaxonomy(row);
 return{revisionId:String(row.id),version:CONTENT_TOPIC_TAXONOMY_VERSION,...request,actor:String(row.actor),reason:String(row.reason),
  semanticVerified:false as const,filterAuthorization:false as const};
}
export async function lockContentTaxonomy(client:PoolClient,owner:string){
 if(!text(owner,4000))throw Error('Taxonomy owner required');
 await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['content-taxonomy:'+owner]);
}
/** Caller owns the short Kernel transaction. Serializing an initially absent
 * head prevents competing first writers; a replay never resets a newer head. */
export async function recordContentTaxonomy(client:PoolClient,owner:string,input:unknown,actor:string,reason:string){
 const request=validateContentTaxonomy(input);
 if(!text(owner,4000)||!text(actor)||!text(reason,2000))throw Error('Taxonomy owner, actor and reason required');
 await lockContentTaxonomy(client,owner);
 const head=await readContentTaxonomy(client,owner),id=hash({owner,version:CONTENT_TOPIC_TAXONOMY_VERSION,request,actor,reason});
 if((await client.query('SELECT 1 FROM content_taxonomy_revisions WHERE owner_id=$1 AND id=$2',[owner,id])).rowCount)
  return{id,replayed:true,current:head?.revisionId===id};
 if((head?.revisionId??null)!==request.previousId)throw Error('Taxonomy revision conflict; read the current head');
 await client.query(`INSERT INTO content_taxonomy_revisions(id,owner_id,taxonomy_version,previous_id,request,input_sha256,actor,reason)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[id,owner,CONTENT_TOPIC_TAXONOMY_VERSION,request.previousId,JSON.stringify(request),hash(request),actor,reason]);
 await client.query(`INSERT INTO content_taxonomy_heads(owner_id,revision_id) VALUES($1,$2)
  ON CONFLICT(owner_id) DO UPDATE SET revision_id=excluded.revision_id`,[owner,id]);
 return{id,replayed:false,current:true};
}
export function contentTaxonomyQueryHints(query:string,taxonomy:NonNullable<Awaited<ReturnType<typeof readContentTaxonomy>>>){
 return taxonomy.entries.flatMap(e=>{
  const aliases=[e.key,...e.aliases].filter(a=>literalTaxonomyMention(query,a));
  return aliases.length?[{facet:e.facet,key:e.key,aliases,taxonomyRevisionId:taxonomy.revisionId}]:[];
 });
}
