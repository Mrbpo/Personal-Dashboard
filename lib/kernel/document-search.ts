import type { Pool } from 'pg';
import {createHash} from 'node:crypto';
import {normalizeDocumentRoutingScope,documentRoutingScopeSql,assertDocumentRoutingScope,type DocumentRoutingScope} from './document-routing-scope.ts';
import {contentTagRoutingMode,routeDocumentContentTagCandidates,type ContentTagRoutingReceipt} from './content-tag-routing.ts';
import {runClassificationShadow,type ClassificationRouteShadow} from './classification-route-shadow.ts';
import {runGuardedClassification,type ClassificationGuardReceipt,type ClassificationQueryPreparation} from './classification-route-guard.ts';
import type{RegisteredAliasExpansion}from'./content-taxonomy-registry.ts';
import{recallClassificationWitnesses}from'./classification-witness-recall.ts';
import {rerankDocumentPages,documentQueryVector,DOCUMENT_SEMANTIC_CANDIDATE_LIMIT} from './document-semantic.ts';
import {rerankDocumentPagesWithAI,selectDocumentPagesWithAI,DOCUMENT_RERANK_CANDIDATE_LIMIT} from './document-rerank.ts';
import {searchDocumentVectorText,documentVectorCoverage,fuseIndependentDocumentRanks,buildHybridDocumentCandidates,selectHybridDocumentEvidence} from './document-vector.ts';
import {recallReferencedDocuments} from './document-references.ts';
import {resolveDocumentSource,requireResolvedDocumentSource,DocumentSourceResolutionError,type DocumentSourceHint} from './document-source.ts';
import {readFullDocumentEvidence,DocumentEvidenceChangedError} from './document-evidence.ts';
import {refineSelectedDocumentPages} from './document-refinement.ts';
import {assertDoclingOrigSearchHints,doclingOrigSearchHash,DOCLING_ORIG_SEARCH_POLICY,
 type PreparedDoclingOrigSearchHints,type DoclingRegionSource} from './docling-source-regions.ts';

const symbolNames: Record<string,string> = {
  '∫':' int integral ', '∑':' sum summation ', '∏':' prod product ', '√':' sqrt root ',
  '∞':' infinity ', 'α':' alpha ', 'β':' beta ', 'γ':' gamma ', 'δ':' delta ',
  'ε':' epsilon ', 'ζ':' zeta ', 'η':' eta ', 'θ':' theta ', 'ι':' iota ', 'κ':' kappa ',
  'λ':' lambda ', 'μ':' mu ', 'ν':' nu ', 'ξ':' xi ', 'ο':' omicron ', 'π':' pi ',
  'ρ':' rho ', 'σ':' sigma ', 'ς':' sigma ', 'τ':' tau ', 'υ':' upsilon ', 'φ':' phi ',
  'χ':' chi ', 'ψ':' psi ', 'ω':' omega ',
  '∩':' cap intersection ', '⋅':' cdot multiply ', '≤':' le less equal ', '≥':' ge greater equal ',
};
const queryStopWords=new Set(('a an the and or of to in on at for from with by as is are was were be been being '+
  'what which who whom whose when where why how do does did can could would should will shall '+
  'it its this that these those then than also into about given find explain describe show me '+
  'we our you your they their them he she his her has have had').split(' '));

/** The original transcription remains unchanged; this copy is only for search. */
export function documentSearchText(value:string):string {
  // Only the source-math serializer's exact paired script tags. Remove the
  // real tags before decoding their fixed entities once: a literal encoded
  // '<sup>' inside a script must not become another tag to strip.
  const searchValue=value.replace(/<(sub|sup)>([^<>]*)<\/\1>/g,(_all,_tag,body:string)=>
    body.replace(/&(?:amp|lt|gt);/g,entity=>entity==='&amp;'?'&':entity==='&lt;'?'<':'>'));
  const formulae=[...searchValue.matchAll(/\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)/gu)].map(([formula])=>formula);
  if(!formulae.length&&searchValue.length<400&&/[\\^_=]/u.test(searchValue))formulae.push(searchValue);
  const atoms=[...new Set(formulae.flatMap(formula=>
    [...formula.replace(/\\[a-z]+/giu,' ').toLowerCase().matchAll(/[a-z]/gu)].map(([letter])=>`math${letter}`)))];
  const text=searchValue.normalize('NFKC').toLowerCase()
    .replace(/([\p{L}])-\s*\r?\n\s*([\p{L}])/gu,'$1$2')
    .replace(/[∫∑∏√∞αβγδεζηθικλμνξοπρσςτυφχψω∩⋅≤≥]/gu,symbol=>symbolNames[symbol])
    .replace(/\\(?:left|right|mathrm|mathbf|operatorname|text)\b/gu,' ')
    .replace(/\\int\b/gu,' int integral ').replace(/\\sum\b/gu,' sum summation ')
    .replace(/\\(?:tfrac|dfrac|frac)\b/gu,' frac fraction ').replace(/\\sqrt\b/gu,' sqrt root ')
    .replace(/\\var(epsilon|theta|kappa|pi|rho|sigma|phi)\b/gu,' $1 ')
    .replace(/\\([a-z]+)/gu,' $1 ')
    .replace(/([\p{L}])([\p{N}])/gu,'$1 $2').replace(/([\p{N}])([\p{L}])/gu,'$1 $2')
    .replace(/[^\p{L}\p{N}]+/gu,' ').replace(/\s+/g,' ').trim();
  // PostgreSQL's default parser treats an unspaced CJK phrase as one token.
  const cjkTokens=[...text.matchAll(/[\u3400-\u9fff]{2,}/gu)].flatMap(([run])=>
    Array.from({length:run.length-1},(_,index)=>run.slice(index,index+2)));
  return `${text} ${cjkTokens.join(' ')} ${atoms.join(' ')}`.trim();
}

/** Share the existing lexical query policy with supplemental candidate lanes. */
export function documentSearchTerms(query:string):{normalized:string;words:string[]}{
  const normalized=documentSearchText(query).slice(0,4000);
  const formulaQuery=/[\\^_=∫∑√]/u.test(query);
  return{normalized,words:documentSearchWords(normalized,formulaQuery).slice(0,40)};
}
/** Exact retrieval observations, not parsed quantities or inferred units.
 * Keep the indexed normalization unchanged; decimal precision/signs survive in
 * a bounded original-text lane. Unsupported composite formats stay lexical. */
export function documentNumericQueryLiterals(query:string):{literals:string[];patterns:string[];unavailableReason?:string}{
 const text=query.normalize('NFKC').slice(0,4000),literals=new Set<string>();
 const unavailable=(reason:string)=>({literals:[],patterns:[],unavailableReason:reason});
 for(const match of text.matchAll(/[+\-−]?\d+(?:\.\d+)?(?:\s*%)?/gu)){
  const literal=match[0].replace(/\s+/gu,''),percent=literal.endsWith('%'),end=match.index!+match[0].length;
  if(!percent&&!literal.includes('.'))continue;
  if(/[A-Za-z0-9_.+,−-]/u.test(text[match.index!-1]??''))continue;
  if(!percent&&/^(?:[0-9]|\.[0-9]|[eE][+−-]?[0-9])/u.test(text.slice(end)))continue;
  if(literal.length>40)return unavailable('literal-length-limit');
  literals.add(literal);if(literals.size>8)return unavailable('literal-count-limit');
 }
 if(literals.size&&/(?:\d|%),[+−-]?\d|\d(?:\.\d+)?[eE][+−-]?\d/u.test(text))return unavailable('unsupported-composite-number-format');
 const patterns=[...literals].map(literal=>{
  const percent=literal.endsWith('%'),value=percent?literal.slice(0,-1):literal;
  const escaped=value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  return '(^|[^A-Za-z0-9_.+,−-])'+escaped+(percent?'[[:space:]]*%':'(?![0-9]|[.][0-9]|[eE][+−-]?[0-9])');
 });
 return {literals:[...literals],patterns};
}
function documentSearchWords(normalized:string,formulaQuery:boolean){
  const words=[...new Set(normalized.split(' ').filter(word=>word.length>=(formulaQuery?1:2)&&
    (formulaQuery||!queryStopWords.has(word))))];
  // A query made entirely of short variables/numbers must still reach search.
  if(!words.length)words.push(...[...new Set(normalized.split(' ').filter(word=>
    word.length===1&&!queryStopWords.has(word)))]);
  return words;
}
/** Retrieval hints only. Preserve every original meaningful term; limits
 * reject the expansion rather than silently slicing either language. */
export function prepareClassificationQuery(query:string,aliases:RegisteredAliasExpansion|undefined):ClassificationQueryPreparation{
 const original=documentSearchTerms(query),unchanged={query,broadQuery:documentBroadSearchQuery(original.words)};
 if(!aliases)return unchanged;
 const sha=(s:string)=>createHash('sha256').update(s).digest('hex'),base={policy:'registered-alias-lexical-v1' as const,
  taxonomyRevisionId:aliases.taxonomyRevisionId,aliasSetSha256:aliases.aliasSetSha256,originalQuerySha256:sha(query),
  originalTermCount:original.words.length};
 const stop=(status:'unavailable'|'unchanged',reason:string):ClassificationQueryPreparation=>({...unchanged,
  expansion:{...base,status,reason,effectiveQuerySha256:sha(query),expandedTermCount:original.words.length,addedTerms:[]}});
 if(aliases.status!=='ready')return stop('unavailable',aliases.reason);
 if(original.words.some(w=>!/^[\p{L}\p{N}]+$/u.test(w)))return stop('unavailable','original-term-boundary');
 const normalized=aliases.phrases.map(documentSearchText).join(' '),aliasWords=documentSearchWords(normalized,/[\\^_=∫∑√]/u.test(query));
 if(normalized.length>4000||aliasWords.length>40)return stop('unavailable','alias-term-capacity');
 const addedTerms=aliasWords.filter(w=>!original.words.includes(w));if(!addedTerms.length)return stop('unchanged','no-new-terms');
 const words=[...original.words,...addedTerms];
 return{query,terms:words,broadQuery:documentBroadSearchQuery(words),expansion:{...base,status:'expanded',reason:'registered-aliases',
  effectiveQuerySha256:sha(words.join(' ')),expandedTermCount:words.length,addedTerms}};
}

export function splitDocumentText(text:string):string[] {
  const out:string[]=[];
  for(let start=0;start<text.length;start+=1400){out.push(text.slice(start,start+1600));if(start+1600>=text.length)break;}
  return out;
}

export type DocumentOrigSearchBinding=DoclingRegionSource&{currentVersionId:string;sourceVersionId:string;evidenceId:string;parserVersion:string};
export type DocumentOrigSearchProvenance={policy:typeof DOCLING_ORIG_SEARCH_POLICY;binding:DocumentOrigSearchBinding;
 basePolicy:'document-search-text-v1';baseSearchSha256:string;searchTextSha256:string;hints:PreparedDoclingOrigSearchHints;provenanceSha256:string};
function origSearchParts(body:string,hints:PreparedDoclingOrigSearchHints){
 const base=documentSearchText(body),missing=hints.entries.filter(e=>!body.includes(e.orig)).map(e=>e.orig).join('\n');
 return {base,searchText:[base,documentSearchText(missing)].filter(Boolean).join(' '),hasHints:Boolean(missing)};
}
function origSource(binding:DocumentOrigSearchBinding):DoclingRegionSource{
 return {owner:binding.owner,documentId:binding.documentId,sourceHash:binding.sourceHash,pageCount:binding.pageCount,physicalPage:binding.physicalPage};
}
/** This auxiliary field never becomes body/quote evidence. A stored base
 * snapshot is deliberately unnecessary: reconstruct from the unchanged body.
 * Unknown pre-existing page search additions cause a refusal, not data loss.
 * Native table search remains in its own existing candidate index. */
export function projectDocumentOrigSearch(body:string,currentSearch:string,old:DocumentOrigSearchProvenance|null,
 hints:PreparedDoclingOrigSearchHints|null,binding:DocumentOrigSearchBinding){
 const base=documentSearchText(body),bodyHash=createBodyHash(body);
 if(old){
  assertDocumentOrigSearchProvenance(old,binding,bodyHash);
  const previous=origSearchParts(body,old.hints);
  if(previous.searchText!==currentSearch||old.baseSearchSha256!==createBodyHash(base)||old.searchTextSha256!==createBodyHash(currentSearch))throw Error('Orig search previous index differs');
 }else if(currentSearch!==''&&currentSearch!==base&&currentSearch!==body)throw Error('Unknown existing page search additions; index preserved');
 if(!hints){if(old)throw Error('Registered orig hints unavailable; index preserved');return {searchText:base,provenance:null};}
 assertDoclingOrigSearchHints(hints,origSource(binding),bodyHash,binding.parserVersion);
 const parts=origSearchParts(body,hints);if(!parts.hasHints)return {searchText:base,provenance:null};
 const content:Omit<DocumentOrigSearchProvenance,'provenanceSha256'>={policy:DOCLING_ORIG_SEARCH_POLICY,binding,
  basePolicy:'document-search-text-v1',baseSearchSha256:createBodyHash(parts.base),searchTextSha256:createBodyHash(parts.searchText),hints};
 return {searchText:parts.searchText,provenance:{...content,provenanceSha256:doclingOrigSearchHash(content)}};
}
const createBodyHash=(body:string)=>createHash('sha256').update(body).digest('hex');
export function assertDocumentOrigSearchProvenance(value:DocumentOrigSearchProvenance,binding:DocumentOrigSearchBinding,bodySha256:string){
 if(!value||value.policy!==DOCLING_ORIG_SEARCH_POLICY||value.basePolicy!=='document-search-text-v1'||
  doclingOrigSearchHash(value.binding)!==doclingOrigSearchHash(binding)||!binding.currentVersionId||!binding.sourceVersionId||!binding.evidenceId||
  !/^[a-f0-9]{64}$/.test(value.baseSearchSha256)||!/^[a-f0-9]{64}$/.test(value.searchTextSha256))throw Error('Orig search source binding differs');
 const {provenanceSha256,...content}=value;
 if(provenanceSha256!==doclingOrigSearchHash(content))throw Error('Orig search provenance checksum differs');
 assertDoclingOrigSearchHints(value.hints,origSource(binding),bodySha256,binding.parserVersion);
}
export function documentOrigSearchMetadata(value:DocumentOrigSearchProvenance,binding:DocumentOrigSearchBinding,bodySha256:string,searchTextSha256:string){
 assertDocumentOrigSearchProvenance(value,binding,bodySha256);
 if(searchTextSha256!==value.searchTextSha256)throw Error('Orig search index checksum differs');
 return {policy:value.policy,authority:'unverified-retrieval-hint' as const,provenanceSha256:value.provenanceSha256,
  hintSha256:value.hints.hintSha256,rawResults:value.hints.references.map(r=>({...r,copyIndices:[...r.copyIndices]})),
  references:value.hints.entries.map(e=>e.reference),visibilityVerified:false as const,semanticRelationsVerified:false as const};
}

export type DocumentTextHit={id:string;document_id:string;course_id:string;name:string;origin:string;
  origin_key:string;source_hash:string;body:string;locator:string;page_number:number;
  evidence_id:string;source_version_id:string;parser_version:string;score:number;parser_warnings?:string[];
  content_kind?:'page'|'time_segment';start_ms?:number|null;end_ms?:number|null;
  // IDF-weighted stored search-text coverage, not factual confidence. Existing
  // transcription warnings and repeated headers can also contain matching terms.
  lexical_support?:number;
  evidence_body?:'full-page';
  retrieval_hint?:ReturnType<typeof documentOrigSearchMetadata>;
  retrieval_scope?:'selected-title-scoped';
  content_tag_routing?:ContentTagRoutingReceipt;
  classification_route_shadow?:ClassificationRouteShadow;
  classification_route_guard?:ClassificationGuardReceipt;
  rerank_model?:'gpt-5-mini'|'gpt-6-astra';rerank_reasoning_effort?:'low'|'medium'|'high'|'xhigh'|'max';
  rerank_max_output_tokens?:number;
  refinement_mode?:'adjacent-pages'|'no-new-neighbors';refinement_candidate_count?:number;
  refined_from?:Array<{document_id:string;page_number:number;source_version_id:string;evidence_id:string}>;
  refinement_seeds?:Array<{document_id:string;page_number:number;source_version_id:string;evidence_id:string}>;
  retrieval_mode?:'keyword'|'semantic'|'ai-rerank'|'keyword-fallback'|'classification-witness';degraded_reason?:string};

export type DocumentSearchOptions={courseId?:string;documentId?:string;routingScope?:DocumentRoutingScope;sourceHint?:DocumentSourceHint;
 limit?:number;strict?:boolean;semantic?:boolean;aiRerank?:boolean;hybrid?:boolean;relatedDocuments?:boolean;
 refineAdjacent?:boolean;
 evidenceBody?:'snippet'|'full-page'};

// Use majority available query information as the support target, admitting the
// half-weight boundary. This is lexical coverage, not calibrated relevance.
// BM25 rank alone does not establish support; absent query terms carry no weight.
export const DOCUMENT_LEXICAL_SUPPORT_THRESHOLD=.5;
const evidenceIdentity=(hit:DocumentTextHit)=>JSON.stringify([
  hit.document_id,hit.page_number,hit.source_version_id,hit.evidence_id]);

/** Protect one supported lexical source without overriding the AI's first four.
 * Only candidates validated by the AI reranker can move. Hybrid selection must
 * supply its validated candidate tail before slicing; an AI-only top five cannot
 * protect a strongly supported page omitted by that selection.
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

/** Supplement, never replace, protected selections. Seeds must belong to the
 * same verified initial pool; modality snippets cannot substitute identities. */
export function independentDocumentRefinementSeeds(selected:DocumentTextHit[],lexical:DocumentTextHit[],
 dense:DocumentTextHit[],candidates:DocumentTextHit[]):DocumentTextHit[]{
 if(selected.length>5||candidates.length>DOCUMENT_RERANK_CANDIDATE_LIMIT)throw new Error('Invalid independent PDF seed scope');
 const pageKey=(hit:DocumentTextHit)=>JSON.stringify([hit.document_id,hit.page_number]);
 const byPage=new Map(candidates.map(hit=>[pageKey(hit),hit]));
 if(byPage.size!==candidates.length)throw new Error('Ambiguous independent PDF seed pool');
 const current=(hit:DocumentTextHit)=>{
  const actual=byPage.get(pageKey(hit));if(!actual)return undefined;
  if(evidenceIdentity(actual)!==evidenceIdentity(hit)||
   ['source_hash','course_id','name','origin','origin_key','parser_version'].some(field=>
    actual[field as keyof DocumentTextHit]!==hit[field as keyof DocumentTextHit]))throw new DocumentEvidenceChangedError();
  return actual;
 };
 for(const hit of selected)if(!current(hit))throw new DocumentEvidenceChangedError();
 const used=new Set(selected.map(evidenceIdentity));
 const eligible=(hit:DocumentTextHit)=>{const actual=current(hit);return actual&&!used.has(evidenceIdentity(actual))?actual:undefined;};
 const denseSeed=dense.map(eligible).find(Boolean);if(denseSeed)used.add(evidenceIdentity(denseSeed));
 const lexicalSeed=lexical.filter(hit=>Number.isFinite(hit.lexical_support)&&
  hit.lexical_support!>=DOCUMENT_LEXICAL_SUPPORT_THRESHOLD&&hit.lexical_support!<=1).map(eligible).find(Boolean);
 const seeds=new Map<string,DocumentTextHit>();
 for(const hit of [denseSeed,lexicalSeed])if(hit)seeds.set(evidenceIdentity(hit),hit);
 return [...seeds.values()];
}

/** Validate the entire current candidate pool before restoring lexical support.
 * The unselected tail retains original evidence, never model-generated pages.
 * Hybrid results remain top five even when a library caller requests 240 hits. */
export async function selectSupportedHybridDocumentPages(pool:Pool,owner:string,query:string,
 lexical:DocumentTextHit[],candidates:DocumentTextHit[],limit:number):Promise<DocumentTextHit[]>{
 const count=Math.min(5,limit,candidates.length);
 const ranked=await selectDocumentPagesWithAI(pool,owner,query,candidates,count);
 // selectDocumentPagesWithAI checks every candidate's owner/current version and
 // evidence both before selection and immediately before returning (also cached).
 const selected=new Set(ranked.map(evidenceIdentity));
 const diagnostic=ranked[0];
 const tail=candidates.filter(hit=>!selected.has(evidenceIdentity(hit))).map(hit=>({...hit,
  rerank_model:diagnostic?.rerank_model,rerank_reasoning_effort:diagnostic?.rerank_reasoning_effort,
  rerank_max_output_tokens:diagnostic?.rerank_max_output_tokens}));
 return fuseLexicallySupportedAIRanks(lexical,[...ranked,...tail],count);
}

function rankingFailure(error:unknown):string{
  const message=error instanceof Error?error.message:String(error);
  if(/budget|预算|上限/iu.test(message))return 'budget-limit';
  if(/timeout|aborted|time limit|signal/iu.test(message))return 'timeout';
  if(/incomplete/iu.test(message))return 'incomplete-output';
  if(/stale|version changed|metadata changed/iu.test(message))return 'stale-version';
  if(/format|permutation|foreign|indices|invalid JSON|dimension/iu.test(message))return 'invalid-output';
  if(/API key|凭据/iu.test(message))return 'credentials-unavailable';
  return 'unavailable';
}

const classificationShadowActive=Symbol('classification-shadow-active');
// Internal prepared terms cannot be supplied through a JSON request. Keep the
// original question/reference query intact while bounding lexical work to80.
const classificationQueryWords=Symbol('classification-query-words');
export const documentBroadSearchQuery=(words:readonly string[])=>words.map(word=>`"${word}"`).join(' OR ');
export async function searchDocumentText(pool:Pool,owner:string,query:string,options:DocumentSearchOptions={}):Promise<DocumentTextHit[]> {
  const tagMode=contentTagRoutingMode();
  options={...options,routingScope:normalizeDocumentRoutingScope(options.routingScope)};
  if(options.evidenceBody!==undefined&&options.evidenceBody!=='snippet'&&options.evidenceBody!=='full-page')throw new Error('Invalid document evidence body mode');
  if(options.refineAdjacent!==undefined&&typeof options.refineAdjacent!=='boolean')throw new Error('Invalid adjacent PDF refinement option');
  if(tagMode==='classification-guarded-lexical-v1'&&!(options as DocumentSearchOptions&{[classificationShadowActive]?:boolean})[classificationShadowActive]&&
   !options.strict&&!options.documentId&&!options.sourceHint&&options.semantic===false&&options.hybrid===false&&options.aiRerank===false&&
   (options.relatedDocuments===false||options.relatedDocuments===true)&&options.refineAdjacent===false){
    const limit=Math.max(1,Math.min(240,options.limit||30)),guarded=await runGuardedClassification<DocumentTextHit,DocumentSearchOptions>(pool,owner,query,options,
     {broadQuery:documentBroadSearchQuery(documentSearchTerms(query).words),limit,prepareQuery:plan=>prepareClassificationQuery(query,plan.aliasExpansion),
      recall:async(db,plan,ordinary)=>{
       const recalled=await recallClassificationWitnesses(db,owner,options,plan,ordinary,limit,options.evidenceBody==='full-page');
       if(options.relatedDocuments&&recalled.receipt.witnessOnlyPages){
        const expanded=await recallReferencedDocuments(db,owner,query,recalled.hits,limit,options.courseId,options.routingScope);
        recalled.hits=options.evidenceBody==='full-page'?await readFullDocumentEvidence(db,owner,expanded):expanded;
        recalled.receipt.referencesExpanded=true;
       }
       return recalled;
      },
      ...(options.relatedDocuments?{expand:async(db:Pool,base:DocumentTextHit[])=>{
      const expanded=await recallReferencedDocuments(db,owner,query,base,limit,options.courseId,options.routingScope);
      return options.evidenceBody==='full-page'?readFullDocumentEvidence(db,owner,expanded):expanded;
     }}:{})},
     (db,scoped,phase,prepared)=>searchDocumentText(db,owner,prepared.query,{...scoped,...(phase==='branch'&&options.relatedDocuments?{relatedDocuments:false,evidenceBody:'snippet' as const}:{}),
      [classificationShadowActive]:true,...(prepared.terms?{[classificationQueryWords]:prepared.terms}:{})} as DocumentSearchOptions));
    await assertDocumentRoutingScope(pool,owner,guarded.map(h=>h.document_id),options);return guarded;
  }
  if(tagMode==='classification-shadow-v1'&&!(options as DocumentSearchOptions&{[classificationShadowActive]?:boolean})[classificationShadowActive]&&
   !options.strict&&!options.documentId&&!options.sourceHint&&options.semantic===false&&options.hybrid===false&&options.aiRerank===false)
    return runClassificationShadow(pool,owner,query,options,scoped=>searchDocumentText(pool,owner,query,{...scoped,[classificationShadowActive]:true} as DocumentSearchOptions));
  const {evidenceBody,...rankingOptions}=options;
  const hits=await searchDocumentSnippets(pool,owner,query,rankingOptions);
  if(evidenceBody!=='full-page'){
    await assertDocumentRoutingScope(pool,owner,hits.map(hit=>hit.document_id),options);return hits;
  }
  const full=await readFullDocumentEvidence(pool,owner,hits);
  if(options.sourceHint&&full.length){
    const current=await resolveDocumentSource(pool,owner,options.sourceHint,{courseId:options.courseId,routingScope:options.routingScope});
    if(current.status!=='resolved'||full.some(hit=>hit.document_id!==current.document.documentId
      ||hit.source_hash!==current.document.sourceHash||hit.source_version_id!==current.document.sourceVersionId))
      throw new DocumentSourceResolutionError('DOCUMENT_SOURCE_CHANGED','Full evidence differs from the current selected source',current);
  }
  await assertDocumentRoutingScope(pool,owner,full.map(hit=>hit.document_id),options);return full;
}

async function searchDocumentSnippets(pool:Pool,owner:string,query:string,options:DocumentSearchOptions):Promise<DocumentTextHit[]> {
  if(options.sourceHint!==undefined){
    const resolution=await resolveDocumentSource(pool,owner,options.sourceHint,{courseId:options.courseId,routingScope:options.routingScope});
    const selected=requireResolvedDocumentSource(resolution);
    if(options.documentId&&options.documentId!==selected.documentId)
      throw new DocumentSourceResolutionError('DOCUMENT_SOURCE_SCOPE_CONFLICT','Document ID conflicts with the selected title',resolution);
    const {sourceHint,...scopedOptions}=options;
    // The original relevance query passes through unchanged. Only a uniquely
    // resolved visible title can become this internal document scope.
    const hits=await searchDocumentText(pool,owner,query,{...scopedOptions,documentId:selected.documentId});
    const current=await resolveDocumentSource(pool,owner,sourceHint,{courseId:options.courseId,routingScope:options.routingScope});
    if(current.status!=='resolved'||current.document.documentId!==selected.documentId
      ||current.document.currentVersionId!==selected.currentVersionId
      ||current.document.sourceVersionId!==selected.sourceVersionId||current.document.sourceHash!==selected.sourceHash)
      throw new DocumentSourceResolutionError('DOCUMENT_SOURCE_CHANGED','Selected source changed during retrieval',current);
    const finalSource=current.document;
    // A concurrent replay can restore the original head after search read a
    // different version. Matching before/after heads alone cannot rule out ABA.
    if(hits.some(hit=>hit.document_id!==finalSource.documentId||hit.source_hash!==finalSource.sourceHash
      ||hit.source_version_id!==finalSource.sourceVersionId))
      throw new DocumentSourceResolutionError('DOCUMENT_SOURCE_CHANGED','Returned evidence differs from the current selected source',current);
    return hits.map(hit=>({...hit,retrieval_scope:'selected-title-scoped' as const}));
  }
  const original=documentSearchTerms(query),normalized=original.normalized,
    offered=(options as DocumentSearchOptions&{[classificationQueryWords]?:string[]})[classificationQueryWords],words=offered??original.words;
  if(offered&&(!Array.isArray(offered)||offered.length>80||new Set(offered).size!==offered.length||
    offered.some(w=>typeof w!=='string'||!/^[\p{L}\p{N}]+$/u.test(w))||original.words.some(w=>!offered.includes(w))))throw Error('Invalid prepared classification query');
  if(!words.length)return [];
  const limit=Math.max(1,Math.min(240,options.limit||30));
  const aiRerank=Boolean((options.aiRerank??(process.env.KERNEL_DOCUMENT_RERANK==='true'))&&!options.strict);
  const hybrid=Boolean((options.hybrid??(process.env.KERNEL_DOCUMENT_HYBRID==='true'))&&!options.strict);
  if(options.refineAdjacent&&(!hybrid||!aiRerank))throw new Error('Adjacent PDF refinement requires hybrid AI retrieval');
  const semantic=Boolean((options.semantic||aiRerank||hybrid)&&!options.strict);
  const route=(candidates:DocumentTextHit[])=>options.strict?Promise.resolve(candidates):routeDocumentContentTagCandidates(pool,owner,query,candidates);
  // Dense recall and keyword scoring are independent. Start the bounded query
  // embedding concurrently; document embeddings are prepared by the worker.
  const dense=hybrid?(async()=>{
    const scope={courseId:options.courseId,documentId:options.documentId,routingScope:options.routingScope};
    const coverage=await documentVectorCoverage(pool,owner,scope);
    if(!coverage.complete||coverage.totalPages===0)return {hits:[],coverage};
    const input=Array.from(query.normalize('NFKC').replace(/\s+/gu,' ').trim()).slice(0,4000).join('');
    const embedding=await documentQueryVector(pool,owner,input,Date.now()+30000);
    return searchDocumentVectorText(pool,owner,embedding,{courseId:options.courseId,
      documentId:options.documentId,routingScope:options.routingScope,limit:DOCUMENT_SEMANTIC_CANDIDATE_LIMIT});
  })().then(value=>({value,error:undefined}),error=>({value:undefined,error})):null;
  const args:unknown[]=[owner,options.strict?normalized:words.join(' '),documentBroadSearchQuery(words),semantic?DOCUMENT_SEMANTIC_CANDIDATE_LIMIT:limit,words];
  const course=options.courseId?`AND d.course_id=$${args.push(options.courseId)}`:'';
  const document=options.documentId?`AND d.id=$${args.push(options.documentId)}`:'';
  const routing=documentRoutingScopeSql(options.routingScope,args);
  const numeric=documentNumericQueryLiterals(query);
  if(options.strict&&numeric.unavailableReason)return [];
  const numericArg=numeric.patterns.length?`$${args.push(numeric.patterns)}::text[]`:undefined;
  const numericValuesArg=numericArg?`$${args.push(numeric.literals.map(literal=>literal.replace(/%$/u,'')))}::text[]`:undefined;
  // A literal substring is necessary for the escaped regex to match. CASE
  // keeps the expensive boundary regex off unrelated original page bodies.
  const numericCount=(body:string)=>`(SELECT count(*)::int FROM unnest(${numericArg},${numericValuesArg}) literal(pattern,value)
    WHERE CASE WHEN strpos(normalize(${body},NFKC),literal.value)>0 THEN normalize(${body},NFKC) ~ literal.pattern ELSE false END)`;
  // Materialize the expensive normalization once per visible page, then only
  // retain version/page/count. PostgreSQL otherwise inlines the correlated
  // count repeatedly for filtering, scoring and the score window.
  const numericPages=numericArg?`, numeric_pages AS MATERIALIZED (
    SELECT c.version_id,c.page_number,normalize(c.body,NFKC) numeric_body
    FROM document_text_pages c JOIN visible_documents d ON d.current_version_id=c.version_id),
    numeric_observations AS MATERIALIZED (SELECT c.version_id,c.page_number,
      (SELECT count(*)::int FROM unnest(${numericArg},${numericValuesArg}) literal(pattern,value)
        WHERE CASE WHEN strpos(c.numeric_body,literal.value)>0 THEN c.numeric_body ~ literal.pattern ELSE false END) matches
      FROM numeric_pages c)` :'';
  const numericJoin=numericArg?`JOIN numeric_observations literal_counts ON literal_counts.version_id=c.version_id AND literal_counts.page_number=c.page_number`:'';
  const baseMatch=options.strict?'c.search_vector @@ q.exact':'c.search_vector @@ q.broad';
  const match=numericArg?(options.strict?`(${baseMatch} AND literal_counts.matches=${numeric.patterns.length})`:
    `(${baseMatch} OR literal_counts.matches>0)`):baseMatch;
  const scoredName=numericArg?'scored_numeric_base':'scored';
  const numericScores=numericArg?`, scored AS (SELECT *,base_score+literal_matches*(max(base_score) OVER()+1) score FROM scored_numeric_base)`:'';
  const rows=await pool.query<DocumentTextHit&{orig_provenance?:DocumentOrigSearchProvenance|null;orig_version_id:string;orig_page_count:number;orig_body_sha256:string;orig_search_sha256:string}>(`
    WITH q AS (SELECT
      plainto_tsquery('english',$2) || plainto_tsquery('simple',$2) AS exact,
      websearch_to_tsquery('english',$3) || websearch_to_tsquery('simple',$3) AS broad),
    visible_documents AS MATERIALIZED (SELECT d.id,d.current_version_id FROM document_texts d
      WHERE d.owner_id=$1 AND d.hidden=false ${course} ${document} ${routing}
      AND NOT EXISTS (SELECT 1 FROM document_texts newer WHERE newer.owner_id=d.owner_id
        AND newer.origin=d.origin AND newer.origin_key=d.origin_key AND newer.hidden=false
        AND (newer.created_at>d.created_at OR (newer.created_at=d.created_at AND newer.id>d.id))))${numericPages},
    terms AS (SELECT term,plainto_tsquery('english',term)||plainto_tsquery('simple',term) query FROM unnest($5::text[]) term),
    collection AS MATERIALIZED (SELECT count(*) n,greatest(1,avg(length(c.search_vector))) avg_length
      FROM document_text_pages c JOIN visible_documents d ON d.current_version_id=c.version_id),
    frequencies AS MATERIALIZED (SELECT t.*, (SELECT count(*) FROM document_text_pages s
      JOIN visible_documents d ON d.current_version_id=s.version_id WHERE s.search_vector @@ t.query) df FROM terms t),
    term_weights AS MATERIALIZED (SELECT f.*,ln(1+(collection.n-f.df+.5)/(f.df+.5)) idf
      FROM frequencies f CROSS JOIN collection WHERE f.df>0),
    ${scoredName} AS (SELECT c.version_id,c.page_number,c.version_id||':'||c.page_number id,0 position,d.id document_id,
      ${numericArg?'literal_counts.matches literal_matches,':''}
      coalesce((SELECT sum(
        f.idf*
        (tf.value*2.2)/(tf.value+1.2*(.25+.75*length(c.search_vector)/collection.avg_length)))
      FROM term_weights f CROSS JOIN LATERAL (SELECT ts_rank_cd(c.search_vector,f.query,0)*10 value) tf
      WHERE c.search_vector @@ f.query AND tf.value>0),0) ${numericArg?'base_score':'score'},
      coalesce((SELECT sum(f.idf) FROM term_weights f WHERE c.search_vector @@ f.query)/
        nullif((SELECT sum(idf) FROM term_weights),0),0) lexical_support
      FROM document_text_pages c JOIN visible_documents d ON d.current_version_id=c.version_id ${numericJoin} CROSS JOIN q CROSS JOIN collection WHERE ${match})
    ${numericScores},
    diverse AS (SELECT *,row_number() OVER (PARTITION BY document_id,page_number ORDER BY score DESC,position) page_rank FROM scored),
    selected AS MATERIALIZED (SELECT * FROM diverse WHERE page_rank=1
      ORDER BY score DESC,document_id,position LIMIT $4)
    SELECT 'pg:'||coalesce(snippet.id,c.id) AS id,d.id AS document_id,coalesce(d.course_id,'') AS course_id,
      d.name,d.origin,d.origin_key,d.source_hash,coalesce(snippet.body,p.body) body,p.locator,p.page_number,p.content_kind,p.start_ms::double precision,p.end_ms::double precision,
      p.evidence_id,v.source_version_id,v.parser_version,v.warnings AS parser_warnings,c.score,c.lexical_support,
      p.search_hint_provenance orig_provenance,v.id orig_version_id,v.page_count orig_page_count,
      CASE WHEN p.search_hint_provenance IS NOT NULL THEN encode(sha256(convert_to(p.body,'UTF8')),'hex') ELSE NULL END orig_body_sha256,
      CASE WHEN p.search_hint_provenance IS NOT NULL THEN encode(sha256(convert_to(p.search_text,'UTF8')),'hex') ELSE NULL END orig_search_sha256
    FROM selected c JOIN document_texts d ON d.id=c.document_id CROSS JOIN q
      JOIN document_text_versions v ON v.id=c.version_id
      JOIN document_text_pages p ON p.version_id=c.version_id AND p.page_number=c.page_number
      LEFT JOIN LATERAL (SELECT chunk.id,chunk.body FROM document_text_chunks chunk
        WHERE chunk.version_id=c.version_id AND chunk.page_number=c.page_number
        ORDER BY ${numericArg?numericCount('chunk.body')+' DESC,':''}ts_rank_cd(chunk.search_vector,q.broad,0) DESC,chunk.position LIMIT 1) snippet ON true
    ORDER BY score DESC,d.id,c.position LIMIT $4`,args);
  let hits:DocumentTextHit[]=rows.rows.map(({orig_provenance,orig_version_id,orig_page_count,orig_body_sha256,orig_search_sha256,...row})=>({...row,
    ...(orig_provenance?{retrieval_hint:documentOrigSearchMetadata(orig_provenance,{owner,documentId:row.document_id,sourceHash:row.source_hash,
      currentVersionId:orig_version_id,sourceVersionId:row.source_version_id,evidenceId:row.evidence_id,parserVersion:row.parser_version,
      pageCount:orig_page_count,physicalPage:row.page_number},orig_body_sha256,orig_search_sha256)}:{}),score:Number(row.score),
    lexical_support:row.lexical_support===undefined?undefined:Number(row.lexical_support),retrieval_mode:'keyword' as const}));
  if(options.relatedDocuments&&!options.strict&&!options.documentId)
    hits=await recallReferencedDocuments(pool,owner,query,hits,semantic?DOCUMENT_SEMANTIC_CANDIDATE_LIMIT:limit,options.courseId,options.routingScope);
  if(semantic&&(hits.length||hybrid)){
    // A model request can outlive the parsed version used for its candidates.
    // Re-read current evidence once, retaining the scope and making no AI calls.
    const keywordFallback=async(reason:string):Promise<DocumentTextHit[]>=>
      (await searchDocumentText(pool,owner,query,{...options,limit,semantic:false,aiRerank:false,hybrid:false,refineAdjacent:false}))
        .map(hit=>({...hit,retrieval_mode:'keyword-fallback' as const,degraded_reason:reason}));
    let reordered:DocumentTextHit[]=hits,semanticFailure:string|undefined;
    let independentDense:DocumentTextHit[]=[];
    if(dense){
      const result=await dense;
      if(result.error)semanticFailure=`semantic:${rankingFailure(result.error)}`;
      else if(!result.value?.coverage.complete)semanticFailure='semantic:index-incomplete';
      else try{independentDense=result.value.hits;reordered=fuseIndependentDocumentRanks(hits,independentDense,
        aiRerank?DOCUMENT_SEMANTIC_CANDIDATE_LIMIT:2*DOCUMENT_SEMANTIC_CANDIDATE_LIMIT);}
      catch(error){semanticFailure=`semantic:${rankingFailure(error)}`;}
    }else{
      try{
        reordered=await rerankDocumentPages(pool,owner,query,hits,aiRerank?80:Math.min(limit,80));
      }catch(error){semanticFailure=`semantic:${rankingFailure(error)}`;}
    }
    if(aiRerank){
      try{
        const candidates=new Map<string,DocumentTextHit>();
        if(hybrid){
          for(const hit of await buildHybridDocumentCandidates(pool,owner,hits,independentDense))
            candidates.set(`${hit.document_id}:${hit.page_number}`,hit);
        }else{
          for(let index=0;index<Math.max(hits.length,reordered.length)&&candidates.size<DOCUMENT_RERANK_CANDIDATE_LIMIT;index++){
            for(const hit of [hits[index],reordered[index]]){
              if(hit&&candidates.size<DOCUMENT_RERANK_CANDIDATE_LIMIT)candidates.set(`${hit.document_id}:${hit.page_number}`,hit);
            }
          }
        }
        const routed=await route([...candidates.values()]);
        const ranked=hybrid?await selectSupportedHybridDocumentPages(pool,owner,query,hits,routed,limit):
          fuseLexicallySupportedAIRanks(hits,
            await rerankDocumentPagesWithAI(pool,owner,query,routed,candidates.size),limit);
        const seeds=options.refineAdjacent?independentDocumentRefinementSeeds(ranked,hits,independentDense,[...candidates.values()]):[];
        const refined=options.refineAdjacent?await refineSelectedDocumentPages(pool,owner,query,ranked,Math.min(5,limit),seeds):ranked;
        return refined
          .map(hit=>({...hit,score:hit.score*1000,retrieval_mode:'ai-rerank' as const,degraded_reason:semanticFailure}));
      }catch(error){
        return keywordFallback([semanticFailure,`ai:${rankingFailure(error)}`].filter(Boolean).join(';'));
      }
    }
    if(semanticFailure){
      return keywordFallback(semanticFailure);
    }
    if(hybrid&&reordered.length){
      const current=await pool.query(`WITH requested AS (SELECT * FROM jsonb_to_recordset($2::jsonb)
        AS r(document_id text,page_number integer,source_version_id text,evidence_id text))
        SELECT count(*) n FROM requested r JOIN document_texts d ON d.id=r.document_id
          AND d.owner_id=$1 AND d.hidden=false
        JOIN document_text_versions v ON v.id=d.current_version_id AND v.source_version_id=r.source_version_id
        JOIN document_text_pages p ON p.version_id=v.id AND p.page_number=r.page_number AND p.evidence_id=r.evidence_id
        WHERE NOT EXISTS (SELECT 1 FROM document_texts newer WHERE newer.owner_id=d.owner_id
          AND newer.origin=d.origin AND newer.origin_key=d.origin_key AND newer.hidden=false
          AND (newer.created_at>d.created_at OR (newer.created_at=d.created_at AND newer.id>d.id)))`,
        [owner,JSON.stringify(reordered.map(hit=>({document_id:hit.document_id,page_number:hit.page_number,
          source_version_id:hit.source_version_id,evidence_id:hit.evidence_id})))]);
      if(Number(current.rows[0].n)!==reordered.length)return keywordFallback('semantic:stale-version');
    }
    const routed=await route(reordered),selected=hybrid?selectHybridDocumentEvidence(hits,independentDense,routed,limit):routed.slice(0,limit);
    return selected.map(hit=>({...hit,score:hit.score*1000,retrieval_mode:'semantic' as const}));
  }
  return (await route(hits)).slice(0,limit);
}
