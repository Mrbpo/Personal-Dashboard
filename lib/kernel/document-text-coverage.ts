import {createHash} from 'node:crypto';
import {COMPLETE_DOCUMENT_SOURCE_LIMITS,type DocumentTextSourceManifest} from './document-context.ts';
import type {DocumentEvidenceHit} from './document-evidence.ts';

const sha=(text:string)=>createHash('sha256').update(text).digest('hex');
const canonical=(value:unknown)=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)
 ?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
const invalid=():never=>{throw Error('Persisted text coverage binding changed');};
type Source=DocumentTextSourceManifest['source'];
type Support={id:string;kind:'text'|'image';documentId:string;documentVersionId:string;sourceVersionId:string;sourceHash:string;
 evidenceId:string;sha256:string;text?:string};
type Unit={supportId:string;startUtf16:number;endUtf16:number;text:string;selectable:boolean};
const same=(support:Support,source:Source)=>support.documentId===source.documentId&&support.documentVersionId===source.currentVersionId&&
 support.sourceVersionId===source.sourceVersionId&&support.sourceHash===source.sourceHash;

/** Kernel-owned reader manifest only. Complete stored text is neither complete
 * original content nor faithful OCR, and never establishes visual absence. */
export function preparePersistedTextCoverage(manifest:DocumentTextSourceManifest,anchors:DocumentEvidenceHit[]){
 const {manifestSha256,...unsigned}=manifest,source=manifest.source,limits=COMPLETE_DOCUMENT_SOURCE_LIMITS;
 if(manifest.method!=='current-persisted-text-v1'||manifest.nodeOrder!=='persisted-source-order'||
  manifest.textCoverage!=='all-current-persisted-nodes'||sha(canonical(unsigned))!==manifestSha256||
  !manifest.structureManifestSha256||!/^[a-f0-9]{64}$/.test(manifest.structureManifestSha256)||
  manifest.originalFileCompletenessVerified!==false||manifest.visualCompletenessVerified!==false||
  !Number.isSafeInteger(manifest.sourceNodeCount)||manifest.sourceNodeCount<1||manifest.sourceNodeCount>limits.nodes||
  manifest.returnedNodeCount!==manifest.sourceNodeCount)invalid();
 const nodes=anchors.filter(a=>a.document_id===source.documentId).sort((a,b)=>a.page_number-b.page_number);
 if(nodes.length!==manifest.sourceNodeCount||nodes.some((a,i)=>a.id!==`pg:${source.currentVersionId}:${i+1}`||
  a.page_number!==i+1||a.source_version_id!==source.sourceVersionId||a.source_hash!==source.sourceHash||a.evidence_body!=='full-page')||
  new Set(nodes.map(a=>a.evidence_id)).size!==nodes.length||
  nodes.reduce((n,a)=>n+Array.from(a.body).length,0)!==manifest.sourceBodyCodepoints||
  nodes.reduce((n,a)=>n+Buffer.byteLength(a.body),0)!==manifest.sourceBodyUtf8Bytes||
  manifest.sourceBodyCodepoints>limits.bodyCodepoints||manifest.sourceBodyUtf8Bytes>limits.bodyUtf8Bytes||
  sha(canonical(nodes.map(a=>a.body)))!==manifest.orderedTextSha256)invalid();
 return {policy:'current-persisted-text-coverage-v1' as const,source:{...source},sourceManifestSha256:manifestSha256,
  structureManifestSha256:manifest.structureManifestSha256,orderedTextSha256:manifest.orderedTextSha256!,
  expectedNodeCount:nodes.length,nodes:nodes.map(a=>({evidenceId:a.evidence_id,storedNodeNumber:a.page_number,
   bodySha256:sha(a.body),bodyUtf16Length:a.body.length})),
  originalFileCompletenessVerified:false as const,visualCompletenessVerified:false as const,textFaithfulness:'unassessed' as const};
}
export type PersistedTextCoverage=ReturnType<typeof preparePersistedTextCoverage>;

/** Recompute from actual selected original spans. Merely retaining a support ID
 * or its hash does not mean its text reached generation. No gap is inferred. */
export function projectPersistedTextCoverage(proof:PersistedTextCoverage,supports:Support[],units:Unit[]){
 const sourceUnits=units.filter(u=>u.selectable&&supports.some(s=>s.id===u.supportId&&s.kind==='text'&&same(s,proof.source))),
  nodes=proof.nodes.map(node=>{
   const matching=supports.filter(s=>s.kind==='text'&&same(s,proof.source)&&s.evidenceId===node.evidenceId);
   if(matching.length!==1)invalid();
   const support=matching[0];
   if(typeof support.text!=='string'||support.sha256!==node.bodySha256||sha(support.text)!==node.bodySha256||support.text.length!==node.bodyUtf16Length)invalid();
   const spans=sourceUnits.filter(u=>u.supportId===support.id).map(u=>{
    if(!Number.isSafeInteger(u.startUtf16)||!Number.isSafeInteger(u.endUtf16)||u.startUtf16<0||u.endUtf16<=u.startUtf16||
     u.endUtf16>node.bodyUtf16Length||support.text!.slice(u.startUtf16,u.endUtf16)!==u.text)invalid();
    return [u.startUtf16,u.endUtf16] as const;
   }).sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
   let end=0;
   for(const span of spans){if(span[0]>end)break;end=Math.max(end,span[1]);}
   return {...node,fullBodySupplied:end===node.bodyUtf16Length};
  }),coveredNodeCount=nodes.filter(n=>n.fullBodySupplied).length;
 return {...proof,nodes,coveredNodeCount,coverage:sourceUnits.length&&coveredNodeCount===proof.expectedNodeCount?
  'all-current-persisted-nodes' as const:'partial-current-persisted-nodes' as const};
}
