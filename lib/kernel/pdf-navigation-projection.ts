import {createHash} from 'node:crypto';
import {pdfVisualCanonical} from './pdf-visual-evidence.ts';
import {coverPdfNavigationContainer,PDF_NAVIGATION_TEXT_POLICY,type readPdfNavigationTextContainers} from './pdf-navigation-text.ts';
import type {DocumentEvidenceHit} from './document-evidence.ts';
import type {DocumentContextSource} from './document-context.ts';

export const PDF_NAVIGATION_PROJECTION_POLICY='selected-native-containers-v1' as const;
export type PdfNavigationPage=Extract<Awaited<ReturnType<typeof readPdfNavigationTextContainers>>,{status:'available'}>;
export type PdfNavigationContext={policy:typeof PDF_NAVIGATION_PROJECTION_POLICY;pages:PdfNavigationPage[];omittedPages:number;unavailablePages:number};
type Support={id:string;kind:'text'|'image';documentId:string;documentVersionId:string;sourceVersionId:string;sourceHash:string;evidenceId:string;sha256:string;text?:string};
type Unit={id:string;supportId:string;startUtf16:number;endUtf16:number;quoteSha256:string;text:string};
const sha=(text:string)=>createHash('sha256').update(text).digest('hex');
export function pdfNavigationProjectionEnabled(value=process.env.STUDY_PDF_NAVIGATION){
 if(value===undefined||value===''||value==='off')return false;
 if(value!==PDF_NAVIGATION_PROJECTION_POLICY)throw Error('Invalid STUDY_PDF_NAVIGATION');
 return true;
}

/** Request-local cache only. Repeated source rechecks still bind each returned
 * observation to the newly read page; stale versions never share a cache key. */
type ExistingPageNode={documentId:string;documentVersionId:string;sourceVersionId:string;sourceHash:string;evidenceId:string;
 body:string;bodySha256:string;kind?:string;ordinal?:number};
export function withPdfNavigationContext<T extends {anchors:DocumentEvidenceHit[];parents?:{nodes:ExistingPageNode[]}[]}>(read:()=>Promise<T>,
 readPage:(source:DocumentContextSource,page:number)=>ReturnType<typeof readPdfNavigationTextContainers>){
 const cache=new Map<string,ReturnType<typeof readPdfNavigationTextContainers>>();
 return async()=>{
  const context=await read(),pages:PdfNavigationPage[]=[],seen=new Set<string>();let omittedPages=0,unavailablePages=0;
  const existingPages=context.anchors.flatMap(anchor=>{
   const version=/^pg:(.+):([0-9]+)$/.exec(anchor.id);
   return !version||Number(version[2])!==anchor.page_number?[]:[{source:{documentId:anchor.document_id,currentVersionId:version[1],
    sourceVersionId:anchor.source_version_id,sourceHash:anchor.source_hash},page:anchor.page_number,evidenceId:anchor.evidence_id,bodySha256:sha(anchor.body)}];
  });
  for(const parent of context.parents??[])for(const node of parent.nodes){
   const ordinal=node.ordinal;
   if(node.kind!=='page'||typeof ordinal!=='number'||!Number.isSafeInteger(ordinal)||ordinal<0)continue;
   if(sha(node.body)!==node.bodySha256)throw Error('Navigation existing page body hash differs');
   existingPages.push({source:{documentId:node.documentId,currentVersionId:node.documentVersionId,sourceVersionId:node.sourceVersionId,
    sourceHash:node.sourceHash},page:ordinal+1,evidenceId:node.evidenceId,bodySha256:node.bodySha256});
  }
  for(const {source,page:physicalPage,evidenceId,bodySha256} of existingPages){
   const key=JSON.stringify([source,physicalPage,evidenceId,bodySha256]);
   if(seen.has(key))continue;seen.add(key);
   if(seen.size>16){omittedPages++;continue;}
   let pending=cache.get(key);if(!pending){pending=readPage(source,physicalPage);cache.set(key,pending);}
   const page=await pending;
   if(page.status!=='available'){unavailablePages++;continue;}
   if(page.source.documentId!==source.documentId||page.source.currentVersionId!==source.currentVersionId||
    page.source.sourceVersionId!==source.sourceVersionId||page.source.sourceHash!==source.sourceHash||
    page.physicalPage!==physicalPage||page.pageEvidenceId!==evidenceId||page.pageBodySha256!==bodySha256)
    throw Error('Navigation current anchor binding differs');
   pages.push(page);
  }
  return {...context,pdfNavigation:{policy:PDF_NAVIGATION_PROJECTION_POLICY,pages,omittedPages,unavailablePages}};
 };
}
const sourceSupport=(page:PdfNavigationPage,s:Support)=>s.kind==='text'&&s.documentId===page.source.documentId&&
 s.documentVersionId===page.source.currentVersionId&&s.sourceVersionId===page.source.sourceVersionId&&s.sourceHash===page.source.sourceHash&&
 s.evidenceId===page.pageEvidenceId&&s.sha256===page.pageBodySha256;

export function assertPdfNavigationContext(context:PdfNavigationContext,supports:Support[]){
 if(context.policy!==PDF_NAVIGATION_PROJECTION_POLICY||!Array.isArray(context.pages)||context.pages.length>16||
  ![context.omittedPages,context.unavailablePages].every(n=>Number.isSafeInteger(n)&&n>=0))throw Error('Invalid bounded navigation context');
 const seen=new Set<string>();
 for(const page of context.pages){
  const {observationSha256,...observation}=page,key=JSON.stringify([page.source.documentId,page.source.currentVersionId,page.physicalPage]);
  if(page.policy!==PDF_NAVIGATION_TEXT_POLICY||page.status!=='available'||page.sourceBindingVerified!==true||page.sourceContentIsUntrusted!==true||
   page.semanticRelationsVerified!==false||page.wordLevelLinkPositionVerified!==false||page.textFaithfulnessVerified!==false||
   page.observations.length>128||sha(pdfVisualCanonical(observation))!==observationSha256||seen.has(key))throw Error('Invalid navigation source observation');
  seen.add(key);const matching=supports.filter(s=>sourceSupport(page,s));
  if(matching.length!==1||sha(matching[0].text??'')!==page.pageBodySha256)throw Error('Navigation current source/body binding differs');
  for(const item of page.observations){
   if(item.link.sourcePageNumber!==page.physicalPage)throw Error('Navigation original page differs');
   if(item.status!=='candidate')continue;const c=item.container,body=matching[0].text!;
   if(!page.compatibleOriginalFrame||item.wordLevelLinkPositionVerified!==false||item.semanticRelationsVerified!==false||
    !Number.isSafeInteger(c.startUtf16)||!Number.isSafeInteger(c.endUtf16)||c.startUtf16<0||c.endUtf16<=c.startUtf16||c.endUtf16>body.length||
    sha(body.slice(c.startUtf16,c.endUtf16))!==c.textSha256)throw Error('Navigation container text binding differs');
  }
 }
}

/** Project source observations onto actual selected quotation ranges. Grouping
 * is native navigation only; no text, citation permission or model step added. */
export function projectPdfNavigationRequest<T extends {input:Array<{role:string;content:unknown}>}>(request:T,context:PdfNavigationContext|undefined,
 supports:Support[],units:Unit[],referenceIds?:string[]){
 if(!context)return {request,receipt:undefined};
 assertPdfNavigationContext(context,supports);
 const selected=new Set(referenceIds??[]),allowed=new Set([...units.map(u=>u.id),...supports.filter(s=>s.kind==='image').map(s=>s.id)]);
 if(selected.size>64||referenceIds&&selected.size!==referenceIds.length||[...selected].some(id=>!allowed.has(id)))throw Error('Invalid navigation selected reference');
 const groups:any[]=[],byTarget=new Map<string,number>();let candidateCount=0,notCovered=0,unknownCount=0,omitted=0;
 for(const page of context.pages){
  const support=supports.find(s=>sourceSupport(page,s))!;
  const selectedUnits=units.filter(u=>u.supportId===support.id&&selected.has(u.id));
  for(const unit of selectedUnits)if(!Number.isSafeInteger(unit.startUtf16)||!Number.isSafeInteger(unit.endUtf16)||
   unit.startUtf16<0||unit.endUtf16<=unit.startUtf16||unit.endUtf16>support.text!.length||
   support.text!.slice(unit.startUtf16,unit.endUtf16)!==unit.text||sha(unit.text)!==unit.quoteSha256)
   throw Error('Navigation selected quote text differs');
  for(const item of page.observations){
   if(item.status!=='candidate'){unknownCount++;continue;}candidateCount++;
   const indices=coverPdfNavigationContainer(item.container,selectedUnits);
   if(!indices){notCovered++;continue;}
   const link=item.link;
   if(link.target.status!=='resolved-page'||!link.destinationName){unknownCount++;continue;}
   const key=JSON.stringify([page.source.documentId,page.source.currentVersionId,page.source.sourceVersionId,page.source.sourceHash,link.destinationName,link.target]);
   const descriptor={source:{...page.source,physicalPage:page.physicalPage,pageEvidenceId:page.pageEvidenceId,pageBodySha256:page.pageBodySha256},
    result:page.result,container:item.container,members:indices.map(index=>{const u=selectedUnits[index];return {id:u.id,quoteSha256:u.quoteSha256,
     intersection:{startUtf16:Math.max(u.startUtf16,item.container.startUtf16),endUtf16:Math.min(u.endUtf16,item.container.endUtf16)}};}),
    annotations:[{annotationIndex:link.annotationIndex,annotationReference:link.annotationReference,sourceRect:link.sourceRect}],
    wordLevelLinkPositionVerified:false,semanticRelationsVerified:false};
   const next=structuredClone(groups),existing=byTarget.get(key);
   if(existing===undefined){if(next.length>=32){omitted++;continue;}next.push({destinationName:link.destinationName,target:link.target,containers:[descriptor]});}
   else{
    const containers=next[existing].containers,match=containers.find((c:any)=>c.source.physicalPage===page.physicalPage&&
     c.container.nodeReference===item.container.nodeReference&&c.source.pageEvidenceId===page.pageEvidenceId);
    if(match)match.annotations.push(...descriptor.annotations);else containers.push(descriptor);
   }
   if(next.reduce((n,g)=>n+g.containers.length,0)>64||Buffer.byteLength(JSON.stringify(next))>30000){omitted++;continue;}
   if(existing===undefined)byTarget.set(key,next.length-1);groups.splice(0,groups.length,...next);
  }
 }
 const wire=groups.length?{policy:PDF_NAVIGATION_PROJECTION_POLICY,semantics:'navigation-only',coverage:'bounded-selected-container-groups',
  semanticRelationsVerified:false,wordLevelLinkPositionVerified:false,groups,
  meaning:'Members collectively cover a parser text container containing a native link rectangle. Shared native targets do not verify semantic equivalence.'}:undefined;
 const receipt={policy:PDF_NAVIGATION_PROJECTION_POLICY,applied:Boolean(wire),groups:groups.length,containers:groups.reduce((n,g)=>n+g.containers.length,0),
  pages:context.pages.length,omittedPages:context.omittedPages,unavailablePages:context.unavailablePages,candidateCount,notCovered,unknownCount,omitted,
  wireSha256:wire?sha(JSON.stringify(wire)):null,wireBytes:wire?Buffer.byteLength(JSON.stringify(wire)):0,semanticRelationsVerified:false};
 if(!wire)return {request,receipt};
 const output=structuredClone(request),user=[...output.input].reverse().find(m=>m.role==='user');
 if(!user||!Array.isArray(user.content))throw Error('Navigation generation packet unavailable');
 const text=user.content.find((part:any)=>part.type==='input_text');
 if(!text||typeof text.text!=='string')throw Error('Navigation generation JSON unavailable');
 const packet=JSON.parse(text.text);if(!packet||typeof packet.question!=='string')throw Error('Navigation generation question unavailable');
 packet.sourceNavigationContainers=wire;text.text=JSON.stringify(packet);
 return {request:output,receipt};
}
