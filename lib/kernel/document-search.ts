import type { Pool } from 'pg';
import {rerankDocumentPages,DOCUMENT_SEMANTIC_CANDIDATE_LIMIT} from './document-semantic.ts';
import {rerankDocumentPagesWithAI,DOCUMENT_RERANK_CANDIDATE_LIMIT} from './document-rerank.ts';

const symbolNames: Record<string,string> = {
  '∫':' int integral ', '∑':' sum summation ', '∏':' prod product ', '√':' sqrt root ',
  '∞':' infinity ', 'α':' alpha ', 'β':' beta ', 'γ':' gamma ', 'δ':' delta ',
  'θ':' theta ', 'λ':' lambda ', 'μ':' mu ', 'σ':' sigma ', 'π':' pi ',
  '∩':' cap intersection ', '⋅':' cdot multiply ', '≤':' le less equal ', '≥':' ge greater equal ',
};
const queryStopWords=new Set(('a an the and or of to in on at for from with by as is are was were be been being '+
  'what which who whom whose when where why how do does did can could would should will shall '+
  'it its this that these those then than also into about given find explain describe show me '+
  'we our you your they their them he she his her has have had').split(' '));

/** The original transcription remains unchanged; this copy is only for search. */
export function documentSearchText(value:string):string {
  const formulae=[...value.matchAll(/\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)/gu)].map(([formula])=>formula);
  if(!formulae.length&&value.length<400&&/[\\^_=]/u.test(value))formulae.push(value);
  const atoms=[...new Set(formulae.flatMap(formula=>
    [...formula.replace(/\\[a-z]+/giu,' ').toLowerCase().matchAll(/[a-z]/gu)].map(([letter])=>`math${letter}`)))];
  const text=value.normalize('NFKC').toLowerCase()
    .replace(/([\p{L}])-\s*\r?\n\s*([\p{L}])/gu,'$1$2')
    .replace(/[∫∑∏√∞αβγδθλμσπ∩⋅≤≥]/gu,symbol=>symbolNames[symbol])
    .replace(/\\(?:left|right|mathrm|mathbf|operatorname|text)\b/gu,' ')
    .replace(/\\int\b/gu,' int integral ').replace(/\\sum\b/gu,' sum summation ')
    .replace(/\\(?:tfrac|dfrac|frac)\b/gu,' frac fraction ').replace(/\\sqrt\b/gu,' sqrt root ')
    .replace(/\\([a-z]+)/gu,' $1 ')
    .replace(/([\p{L}])([\p{N}])/gu,'$1 $2').replace(/([\p{N}])([\p{L}])/gu,'$1 $2')
    .replace(/[^\p{L}\p{N}]+/gu,' ').replace(/\s+/g,' ').trim();
  // PostgreSQL's default parser treats an unspaced CJK phrase as one token.
  const cjkTokens=[...text.matchAll(/[\u3400-\u9fff]{2,}/gu)].flatMap(([run])=>
    Array.from({length:run.length-1},(_,index)=>run.slice(index,index+2)));
  return `${text} ${cjkTokens.join(' ')} ${atoms.join(' ')}`.trim();
}

export function splitDocumentText(text:string):string[] {
  const out:string[]=[];
  for(let start=0;start<text.length;start+=1400){out.push(text.slice(start,start+1600));if(start+1600>=text.length)break;}
  return out;
}

export type DocumentTextHit={id:string;document_id:string;course_id:string;name:string;origin:string;
  origin_key:string;source_hash:string;body:string;locator:string;page_number:number;
  evidence_id:string;source_version_id:string;parser_version:string;score:number;
  // IDF-weighted stored search-text coverage, not factual confidence. Existing
  // transcription warnings and repeated headers can also contain matching terms.
  lexical_support?:number;
  retrieval_mode?:'keyword'|'semantic'|'ai-rerank'|'keyword-fallback';degraded_reason?:string};

// Use majority available query information as the support target, admitting the
// half-weight boundary. This is lexical coverage, not calibrated relevance.
// BM25 rank alone does not establish support; absent query terms carry no weight.
export const DOCUMENT_LEXICAL_SUPPORT_THRESHOLD=.5;
const evidenceIdentity=(hit:DocumentTextHit)=>JSON.stringify([
  hit.document_id,hit.page_number,hit.source_version_id,hit.evidence_id]);

/** Protect one supported lexical source without overriding the AI's first four.
 * Only pages already validated by the AI reranker can move. Fuse the complete
 * permutation before slicing so different result limits share the same prefix.
 */
export function fuseLexicallySupportedAIRanks(lexical:DocumentTextHit[],ranked:DocumentTextHit[],limit=ranked.length):DocumentTextHit[]{
  const positions=new Map(ranked.map((hit,index)=>[evidenceIdentity(hit),index]));
  const protectedHit=lexical.find(hit=>Number.isFinite(hit.lexical_support)&&
    hit.lexical_support!>=DOCUMENT_LEXICAL_SUPPORT_THRESHOLD&&hit.lexical_support!<=1&&
    positions.has(evidenceIdentity(hit)));
  const out=[...ranked];
  if(protectedHit){
    const position=positions.get(evidenceIdentity(protectedHit))!;
    if(position>=5){
      const [validated]=out.splice(position,1);
      out.splice(4,0,validated);
    }
  }
  return out.slice(0,Math.max(0,limit)).map((hit,index)=>({...hit,score:1/(index+1)}));
}

function rankingFailure(error:unknown):string{
  const message=error instanceof Error?error.message:String(error);
  if(/budget|预算|上限/iu.test(message))return 'budget-limit';
  if(/timeout|aborted|time limit|signal/iu.test(message))return 'timeout';
  if(/incomplete/iu.test(message))return 'incomplete-output';
  if(/stale|version changed/iu.test(message))return 'stale-version';
  if(/format|permutation|foreign|indices|invalid JSON|dimension/iu.test(message))return 'invalid-output';
  if(/API key|凭据/iu.test(message))return 'credentials-unavailable';
  return 'unavailable';
}

export async function searchDocumentText(pool:Pool,owner:string,query:string,options:{
  courseId?:string;documentId?:string;limit?:number;strict?:boolean;semantic?:boolean;aiRerank?:boolean;
}={}):Promise<DocumentTextHit[]> {
  const normalized=documentSearchText(query).slice(0,4000);
  const formulaQuery=/[\\^_=∫∑√]/u.test(query);
  const words=[...new Set(normalized.split(' ').filter(word=>word.length>=(formulaQuery?1:2)&&
    (formulaQuery||!queryStopWords.has(word))))].slice(0,40);
  if(!words.length)return [];
  const limit=Math.max(1,Math.min(240,options.limit||30));
  const aiRerank=Boolean(options.aiRerank&&!options.strict);
  const semantic=Boolean((options.semantic||aiRerank)&&!options.strict);
  const args:unknown[]=[owner,options.strict?normalized:words.join(' '),words.map(word=>`"${word}"`).join(' OR '),semantic?DOCUMENT_SEMANTIC_CANDIDATE_LIMIT:limit,words];
  const course=options.courseId?`AND d.course_id=$${args.push(options.courseId)}`:'';
  const document=options.documentId?`AND d.id=$${args.push(options.documentId)}`:'';
  const match=options.strict?'c.search_vector @@ q.exact':'c.search_vector @@ q.broad';
  const rows=await pool.query<DocumentTextHit>(`
    WITH q AS (SELECT
      plainto_tsquery('english',$2) || plainto_tsquery('simple',$2) AS exact,
      websearch_to_tsquery('english',$3) || websearch_to_tsquery('simple',$3) AS broad),
    scoped AS MATERIALIZED (SELECT c.*,c.version_id||':'||c.page_number id,0 position,d.id document_id FROM document_text_pages c
      JOIN document_texts d ON d.current_version_id=c.version_id
      WHERE d.owner_id=$1 AND d.hidden=false ${course} ${document}
      AND NOT EXISTS (SELECT 1 FROM document_texts newer WHERE newer.owner_id=d.owner_id
        AND newer.origin=d.origin AND newer.origin_key=d.origin_key AND newer.hidden=false
        AND (newer.created_at>d.created_at OR (newer.created_at=d.created_at AND newer.id>d.id)))),
    terms AS (SELECT term,plainto_tsquery('english',term)||plainto_tsquery('simple',term) query FROM unnest($5::text[]) term),
    collection AS MATERIALIZED (SELECT count(*) n,greatest(1,avg(length(search_vector))) avg_length FROM scoped),
    frequencies AS MATERIALIZED (SELECT t.*, (SELECT count(*) FROM scoped s WHERE s.search_vector @@ t.query) df FROM terms t),
    term_weights AS MATERIALIZED (SELECT f.*,ln(1+(collection.n-f.df+.5)/(f.df+.5)) idf
      FROM frequencies f CROSS JOIN collection WHERE f.df>0),
    scored AS (SELECT c.*,coalesce((SELECT sum(
        f.idf*
        (tf.value*2.2)/(tf.value+1.2*(.25+.75*length(c.search_vector)/collection.avg_length)))
      FROM term_weights f CROSS JOIN LATERAL (SELECT ts_rank_cd(c.search_vector,f.query,0)*10 value) tf
      WHERE c.search_vector @@ f.query AND tf.value>0),0) score,
      coalesce((SELECT sum(f.idf) FROM term_weights f WHERE c.search_vector @@ f.query)/
        nullif((SELECT sum(idf) FROM term_weights),0),0) lexical_support
      FROM scoped c,q,collection WHERE ${match}),
    diverse AS (SELECT *,row_number() OVER (PARTITION BY document_id,page_number ORDER BY score DESC,position) page_rank FROM scored)
    SELECT 'pg:'||coalesce(snippet.id,c.id) AS id,d.id AS document_id,coalesce(d.course_id,'') AS course_id,
      d.name,d.origin,d.origin_key,d.source_hash,coalesce(snippet.body,c.body) body,p.locator,p.page_number,
      p.evidence_id,v.source_version_id,v.parser_version,c.score,c.lexical_support
    FROM diverse c JOIN document_texts d ON d.id=c.document_id CROSS JOIN q
      JOIN document_text_versions v ON v.id=c.version_id
      JOIN document_text_pages p ON p.version_id=c.version_id AND p.page_number=c.page_number
      LEFT JOIN LATERAL (SELECT chunk.id,chunk.body FROM document_text_chunks chunk
        WHERE chunk.version_id=c.version_id AND chunk.page_number=c.page_number
        ORDER BY ts_rank_cd(chunk.search_vector,q.broad,0) DESC,chunk.position LIMIT 1) snippet ON true
    WHERE c.page_rank=1
    ORDER BY score DESC,d.id,c.position LIMIT $4`,args);
  const hits=rows.rows.map(row=>({...row,score:Number(row.score),
    lexical_support:row.lexical_support===undefined?undefined:Number(row.lexical_support),retrieval_mode:'keyword' as const}));
  if(semantic&&hits.length){
    let reordered:DocumentTextHit[]=hits,semanticFailure:string|undefined;
    try{
      reordered=await rerankDocumentPages(pool,owner,query,hits,aiRerank?80:Math.min(limit,80));
    }catch(error){semanticFailure=`semantic:${rankingFailure(error)}`;}
    if(aiRerank){
      try{
        const candidates=new Map<string,DocumentTextHit>();
        for(let index=0;index<hits.length&&candidates.size<DOCUMENT_RERANK_CANDIDATE_LIMIT;index++){
          for(const hit of [hits[index],reordered[index]]){
            if(hit&&candidates.size<DOCUMENT_RERANK_CANDIDATE_LIMIT)candidates.set(`${hit.document_id}:${hit.page_number}`,hit);
          }
        }
        const ranked=await rerankDocumentPagesWithAI(pool,owner,query,[...candidates.values()],candidates.size);
        return fuseLexicallySupportedAIRanks(hits,ranked,limit)
          .map(hit=>({...hit,score:hit.score*1000,retrieval_mode:'ai-rerank' as const,degraded_reason:semanticFailure}));
      }catch(error){
        return hits.slice(0,limit).map(hit=>({...hit,retrieval_mode:'keyword-fallback' as const,
          degraded_reason:[semanticFailure,`ai:${rankingFailure(error)}`].filter(Boolean).join(';')}));
      }
    }
    if(semanticFailure){
      return hits.slice(0,limit).map(hit=>({...hit,retrieval_mode:'keyword-fallback' as const,
        degraded_reason:semanticFailure}));
    }
    return reordered.map(hit=>({...hit,score:hit.score*1000,retrieval_mode:'semantic' as const}));
  }
  return hits.slice(0,limit);
}
