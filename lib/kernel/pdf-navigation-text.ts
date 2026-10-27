import {createHash} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {readDocumentPageRegions,type DocumentContextSource} from './document-context.ts';
import {readPdfInternalLinkEvidence,PdfVisualEvidenceError,pdfVisualCanonical} from './pdf-visual-evidence.ts';
import type {PdfInternalLink} from './pdf-internal-links.ts';
import type {DoclingPageRegionNode} from './docling-result.ts';

export const PDF_NAVIGATION_TEXT_POLICY='pdf-navigation-text-containers-v1' as const;
export const PDF_NAVIGATION_TEXT_LIMITS=Object.freeze({links:128,bodyBytes:1024*1024,ranges:64});
type Region=Extract<Awaited<ReturnType<typeof readDocumentPageRegions>>,{status:'available'}>;
type TextContainer={nodeReference:string;bbox:Extract<DoclingPageRegionNode['geometry'],{status:'observed'}>['bbox'];
 startUtf16:number;endUtf16:number;textSha256:string};
export type PdfNavigationTextCandidate={link:PdfInternalLink;status:'candidate';container:TextContainer;
 wordLevelLinkPositionVerified:false;semanticRelationsVerified:false}|{link:PdfInternalLink;status:'unknown';reason:string};
const sha=(text:string)=>createHash('sha256').update(text).digest('hex');

/** A geometric/text observation, not a word-level or semantic link. Does not
 * normalize text, bridge gaps, expand evidence or choose a nearest region. */
export function observePdfNavigationText(body:string,region:Region,links:PdfInternalLink[]){
 if(Buffer.byteLength(body)>PDF_NAVIGATION_TEXT_LIMITS.bodyBytes)throw Error('PDF navigation page body exceeds limit');
 const size=region.index.pageSize,frame=region.image.provenance,crop=frame.sourcePageCropBox;
 const compatible=Boolean(size&&frame.rotation===0&&crop.x===0&&crop.y===0&&crop.width===size.width&&crop.height===size.height&&
  frame.pageSizePoints.width===size.width&&frame.pageSizePoints.height===size.height);
 const eligible=region.index.nodes.filter(n=>/^#\/texts\/\d+$/.test(n.reference)&&n.membership==='declared-provenance'&&
  n.textScope==='single-page'&&n.raw.label==='text'&&n.geometry.status==='observed'&&
  n.physicalPageNumbers.length===1&&n.physicalPageNumbers[0]===region.physicalPage);
 const ranges=new Map<string,TextContainer|null>();
 const observations:PdfNavigationTextCandidate[]=links.slice(0,PDF_NAVIGATION_TEXT_LIMITS.links).map(link=>{
  const unknown=(reason:string):PdfNavigationTextCandidate=>({link,status:'unknown',reason});
  if(link.sourcePageNumber!==region.physicalPage)return unknown('different-original-page');
  if(!compatible)return unknown('incompatible-or-unknown-original-frame');
  const rect=link.sourceRect;if(!rect||rect.some(n=>!Number.isFinite(n))||rect[0]>=rect[2]||rect[1]>=rect[3])return unknown('source-rectangle-unknown');
  const matches=eligible.filter(node=>{
   if(node.geometry.status!=='observed')return false;const b=node.geometry.bbox;
   const bottom=b.coord_origin==='BOTTOMLEFT'?b.b:size!.height-b.b,top=b.coord_origin==='BOTTOMLEFT'?b.t:size!.height-b.t;
   if(![b.l,b.r,bottom,top].every(Number.isFinite)||b.l<0||b.r>size!.width||bottom<0||top>size!.height||b.l>=b.r||bottom>=top)return false;
   return b.l<=rect[0]&&bottom<=rect[1]&&b.r>=rect[2]&&top>=rect[3];
  });
  if(matches.length!==1)return unknown(matches.length?'ambiguous-parser-containers':'no-containing-parser-text');
  const node=matches[0];
  if(!ranges.has(node.reference)){
   const text=typeof node.raw.text==='string'&&node.raw.text.trim()?node.raw.text:
    typeof node.raw.orig==='string'&&node.raw.orig.trim()?node.raw.orig:'';
   const start=text?body.indexOf(text):-1;
   ranges.set(node.reference,start<0||body.indexOf(text,start+1)!==-1?null:{nodeReference:node.reference,
    bbox:(node.geometry as Extract<typeof node.geometry,{status:'observed'}>).bbox,startUtf16:start,endUtf16:start+text.length,textSha256:sha(text)});
  }
  const container=ranges.get(node.reference);if(!container)return unknown('parser-text-not-unique-in-stored-page');
  return {link,status:'candidate',container,wordLevelLinkPositionVerified:false,semanticRelationsVerified:false};
 });
 return {observations,omittedLinks:Math.max(0,links.length-observations.length),compatibleOriginalFrame:compatible,
  wordLevelLinkPositionVerified:false as const,semanticRelationsVerified:false as const};
}

/** Return input indices whose exact ranges collectively cover the container.
 * Even whitespace gaps remain gaps. IDs and textual meaning are not inferred. */
export function coverPdfNavigationContainer(container:{startUtf16:number;endUtf16:number},ranges:Array<{startUtf16:number;endUtf16:number}>):number[]|null{
 const valid=(r:{startUtf16:number;endUtf16:number})=>Number.isSafeInteger(r.startUtf16)&&Number.isSafeInteger(r.endUtf16)&&r.startUtf16>=0&&r.endUtf16>r.startUtf16;
 if(!valid(container)||ranges.length>PDF_NAVIGATION_TEXT_LIMITS.ranges||ranges.some(r=>!valid(r)))throw Error('Invalid bounded navigation text ranges');
 const sorted=ranges.map((r,index)=>({...r,index})).sort((a,b)=>a.startUtf16-b.startUtf16||b.endUtf16-a.endUtf16||a.index-b.index);
 let end=container.startUtf16;const selected:number[]=[];
 for(const r of sorted){
  if(r.endUtf16<=end)continue;if(r.startUtf16>end)return null;
  selected.push(r.index);end=r.endUtf16;if(end>=container.endUtf16)return selected;
 }
 return null;
}

/** The current Kernel, not a caller-provided annotation or quote, supplies every
 * source, body, raw region and native navigation observation in this read. */
export async function readPdfNavigationTextContainers(db:Pick<Pool,'query'>|Pick<PoolClient,'query'>,owner:string,source:DocumentContextSource,physicalPage:number){
 if(!Number.isInteger(physicalPage)||physicalPage<1)throw Error('One explicit original PDF page is required');
 const navigation=await readPdfInternalLinkEvidence(db,owner,source);
 const unavailable=(reason:string)=>({policy:PDF_NAVIGATION_TEXT_POLICY,status:'unavailable' as const,source:navigation.source,physicalPage,reason,
  semanticRelationsVerified:false as const});
 if(!navigation.observations)return unavailable('native-navigation-not-recorded');
 let region:Awaited<ReturnType<typeof readDocumentPageRegions>>;
 try{region=await readDocumentPageRegions(db,owner,navigation.source,physicalPage);}
 catch(error){if(error instanceof PdfVisualEvidenceError&&['unavailable','input-limit','byte-limit','count-limit'].includes(error.code))return unavailable(error.code);throw error;}
 if(region.status!=='available')return unavailable(region.reason);
 if(region.visualManifestSha256!==navigation.manifestSha256)throw new PdfVisualEvidenceError('source-changed','Navigation and parser-region manifest differ');
 const pages=(await db.query<{body:string}>(`SELECT p.body FROM document_texts d
 JOIN document_text_versions v ON v.id=d.current_version_id JOIN document_text_pages p ON p.version_id=v.id
 WHERE d.owner_id=$1 AND d.id=$2 AND v.id=$3 AND v.source_version_id=$4 AND d.source_hash=$5
 AND p.page_number=$6 AND p.evidence_id=$7 AND NOT d.hidden`,
 [owner,source.documentId,source.currentVersionId,source.sourceVersionId,source.sourceHash,physicalPage,region.pageEvidenceId])).rows;
 if(pages.length!==1||sha(pages[0].body)!==region.pageBodySha256)throw new PdfVisualEvidenceError('source-changed','Current navigation page text differs');
 if(Buffer.byteLength(pages[0].body)>PDF_NAVIGATION_TEXT_LIMITS.bodyBytes)return unavailable('stored-page-body-limit');
 const value=observePdfNavigationText(pages[0].body,region,navigation.observations.links.filter(l=>l.sourcePageNumber===physicalPage));
 const after=await readPdfInternalLinkEvidence(db,owner,source);
 if(after.manifestSha256!==navigation.manifestSha256)throw new PdfVisualEvidenceError('source-changed','PDF navigation source changed');
 const observation={policy:PDF_NAVIGATION_TEXT_POLICY,status:'available' as const,source:region.source,physicalPage,
  pageEvidenceId:region.pageEvidenceId,pageBodySha256:region.pageBodySha256,parserVersion:region.parserVersion,
  visualManifestSha256:region.visualManifestSha256,result:region.index.result,...value,sourceBindingVerified:true as const,
  textFaithfulnessVerified:false as const,sourceContentIsUntrusted:true as const};
 return {...observation,observationSha256:sha(pdfVisualCanonical(observation))};
}
