import {createHash} from 'node:crypto';
import {COMPLETE_DOCUMENT_SOURCE_LIMITS,type CompleteDocumentSourceManifest} from './document-context.ts';
import type {DocumentAnswerContext} from './document-answer.ts';

export type CompleteStudySourceProof={policy:'selected-complete-initial-v1';selectedDocumentTitle:string;manifest:CompleteDocumentSourceManifest};
const sha=(v:string|Uint8Array)=>createHash('sha256').update(v).digest('hex');
const canonical=(v:unknown)=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)
 ?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);

/** An internal Kernel-reader binding, never a client assertion or evidence of
 * answer correctness. A complete-source manifest cannot license other sources. */
export function validateCompleteStudySource(context:DocumentAnswerContext){
 const proof=context.completeSourceProof;if(!proof)throw Error('Complete initial source proof is required');
 const {manifest:m}=proof,{manifestSha256,...unsigned}=m,limits=COMPLETE_DOCUMENT_SOURCE_LIMITS;
 const fail=():never=>{throw Error('Complete initial source binding changed');};
 if(proof.policy!=='selected-complete-initial-v1'||!proof.selectedDocumentTitle||
  proof.selectedDocumentTitle.normalize('NFKC')!==m.document.name.normalize('NFKC')||m.method!=='complete-current-source'||
  m.nodeOrder!=='original-source'||!m.complete||m.reason!==null||sha(canonical(unsigned))!==manifestSha256||
  !m.structureManifestSha256||!/^[a-f0-9]{64}$/.test(m.structureManifestSha256)||
  canonical(m.limits)!==canonical(limits)||context.sourceCaptionProof||(context.imageAnchors?.length??0)>0||
  (context.imageSelection?.omitted.length??0)>0||!m.sourceNodeCount||m.sourceNodeCount>limits.nodes||
  m.returnedNodeCount!==m.sourceNodeCount||m.nodes.length!==m.sourceNodeCount||context.anchors.length!==m.nodes.length||
  new Set(m.nodes.map(n=>n.evidenceId)).size!==m.nodes.length)fail();
 const s=m.source,same=(v:{documentId:string;currentVersionId:string;sourceVersionId:string;sourceHash:string})=>
  v.documentId===s.documentId&&v.currentVersionId===s.currentVersionId&&v.sourceVersionId===s.sourceVersionId&&v.sourceHash===s.sourceHash;
 for(const [i,n]of m.nodes.entries()){
  const h=context.anchors[i];
  if(n.ordinal!==i||n.documentId!==s.documentId||n.documentVersionId!==s.currentVersionId||n.sourceVersionId!==s.sourceVersionId||n.sourceHash!==s.sourceHash||
   h.document_id!==s.documentId||h.id!==`pg:${s.currentVersionId}:${i+1}`||h.page_number!==i+1||h.source_version_id!==s.sourceVersionId||h.source_hash!==s.sourceHash||
   h.evidence_id!==n.evidenceId||h.locator!==n.locator||sha(h.body)!==n.bodySha256)fail();
 }
 const points=context.anchors.reduce((n,h)=>n+Array.from(h.body).length,0),bytes=context.anchors.reduce((n,h)=>n+Buffer.byteLength(h.body),0);
 if(points!==m.sourceBodyCodepoints||bytes!==m.sourceBodyUtf8Bytes||points>limits.bodyCodepoints||bytes>limits.bodyUtf8Bytes||
  sha(canonical(context.anchors.map(h=>h.body)))!==m.orderedTextSha256)fail();
 for(const p of context.parents)for(const n of p.nodes)if(!same({...n,currentVersionId:n.documentVersionId})||
  !m.nodes.some(x=>x.evidenceId===n.evidenceId&&x.bodySha256===sha(n.body)))fail();
 if(context.images.length!==m.images.length||m.images.length>limits.images||new Set(m.images.map(i=>i.attachmentId)).size!==m.images.length)fail();
 for(const [i,image]of context.images.entries()){
  const row=m.images[i],anchor='anchorEvidenceId'in image?image.anchorEvidenceId:image.captionEvidenceId;
  if(!same(image.source)||!m.nodes.some(n=>n.evidenceId===anchor)||image.attachmentId!==row.attachmentId||image.sha256!==row.sha256||
   image.bytes.length!==row.byteLength||image.byteLength!==row.byteLength||sha(image.bytes)!==row.sha256||image.width!==row.width||image.height!==row.height||
   ('anchorEvidenceId'in image?(row.anchorEvidenceId!==anchor||row.kind!==image.kind||row.physicalPage!==image.physicalPage||row.manifestSha256!==image.manifestSha256):row.captionEvidenceId!==anchor))fail();
 }
 for(const caption of m.nodes.filter(n=>n.kind==='caption'))if(m.images.filter(i=>i.captionEvidenceId===caption.evidenceId).length!==1)fail();
 const imageBytes=context.images.reduce((n,i)=>n+i.byteLength,0),tokens=context.images.reduce((n,i)=>n+2*Math.ceil(i.width/32)*Math.ceil(i.height/32)+1,0);
 if(imageBytes>limits.imageBytes||tokens!==m.imageInputTokenUpper||tokens>limits.imageInputTokens)fail();
 return proof;
}
