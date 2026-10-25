import {createHash} from 'node:crypto';
import {documentTitleMention} from './document-source.ts';
import type {DocumentContextSource} from './document-context.ts';

export const FOCUSED_TEXT_LIMITS=Object.freeze({pages:4,bodyUtf8Bytes:32768});
export type FocusedDocumentText={policy:'bounded-mentioned-source-relevance-v1';source:DocumentContextSource;
 querySha256:string;pages:Array<{evidenceId:string;bodySha256:string}>;coverage:'unassessed';structureRelationsVerified:false};

/** Supplemental relevance only. Attribution and the user's original question
 * remain unchanged; never remove an unverified alias or rewrite its content. */
export function focusedDocumentTextQuery(question:string,title:string):string|null{
 const normalized=question.normalize('NFKC'),mention=documentTitleMention(normalized,title);
 if(!mention)return null;
 const residual=(normalized.slice(0,mention.start)+' '+normalized.slice(mention.end)).trim();
 return /[\p{L}\p{N}]/u.test(residual)?residual:null;
}
export const focusedTextQueryHash=(query:string)=>createHash('sha256').update(query).digest('hex');

export type DocumentSectionIntervalCandidates={policy:'literal-section-interval-candidates-v1';status:'available'|'unavailable';reason:string|null;
 labels:string[];ranges:Array<{label:string;startPage:number;boundaryPage:number;startUtf16:number;boundaryUtf16:number;boundaryLabel:string}>;
 pages:Array<{physicalPage:number;evidenceId:string;bodySha256:string}>;semanticsVerified:false;coverage:'unassessed'};
/** A literal heading interval is only a bounded reading candidate. Keep the
 * boundary page too: neither columns nor section membership are inferred. */
export function locateDocumentSectionIntervals(question:string,title:string,pages:Array<{physicalPage:number;evidenceId:string;body:string}>):DocumentSectionIntervalCandidates|undefined{
 const query=focusedDocumentTextQuery(question,title);if(!query)return;
 const matches=[...query.matchAll(/\bsections?\s+([1-9]\d*(?:\.\d+)+(?:\s*(?:,|and|&)\s*[1-9]\d*(?:\.\d+)+)*)|第?\s*([1-9]\d*(?:\.\d+)+)\s*节/giu)];
 if(!matches.length)return;
 const labels=[...new Set(matches.flatMap(m=>(m[1]??m[2]).match(/[1-9]\d*(?:\.\d+)+/g)!))],
  result:DocumentSectionIntervalCandidates={policy:'literal-section-interval-candidates-v1',status:'unavailable',reason:null,
   labels,ranges:[],pages:[],semanticsVerified:false,coverage:'unassessed'},unavailable=(reason:string)=>({...result,reason});
 if(labels.length>4||labels.some(label=>label.split('.').some(n=>String(Number(n))!==n))||
  matches.some(m=>/^\s*(?:[-–—]|to)\s*\d/iu.test(query.slice(m.index!+m[0].length))))return unavailable('ambiguous-section-labels');
 const ordered=[...pages].sort((a,b)=>a.physicalPage-b.physicalPage);
 if(!ordered.length||ordered.length>512||ordered.some(p=>!Number.isInteger(p.physicalPage)||p.physicalPage<1||!p.evidenceId)||
  new Set(ordered.map(p=>p.physicalPage)).size!==ordered.length||new Set(ordered.map(p=>p.evidenceId)).size!==ordered.length||
  ordered.reduce((n,p)=>n+Buffer.byteLength(p.body),0)>262144)return unavailable('unavailable-source-pages');
 const headings=ordered.flatMap(page=>[...page.body.matchAll(/^[ \t]*(?:#{1,6}[ \t]+)?([1-9]\d*(?:\.\d+)+)[ \t]+[^\r\n]+/gm)]
  .map(m=>({label:m[1],physicalPage:page.physicalPage,offset:m.index!}))),ranges:DocumentSectionIntervalCandidates['ranges']=[],selected=new Set<number>();
 for(const label of labels){
  const found=headings.filter(h=>h.label===label);if(found.length!==1)return unavailable(found.length?'ambiguous-heading':'heading-unavailable');
  const start=found[0],parts=label.split('.'),prefix=parts.slice(0,-1).join('.')+'.',next=prefix+(Number(parts.at(-1))+1),
   boundary=headings.find(h=>(h.physicalPage>start.physicalPage||h.physicalPage===start.physicalPage&&h.offset>start.offset)&&
    h.label.split('.').length===parts.length&&h.label.startsWith(prefix));
  if(!boundary||boundary.label!==next)return unavailable('next-sibling-heading-unavailable');
  if(boundary.physicalPage-start.physicalPage+1>14)return unavailable('section-page-limit');
  for(let page=start.physicalPage;page<=boundary.physicalPage;page++){
   if(!ordered.some(p=>p.physicalPage===page))return unavailable('section-page-gap');selected.add(page);
  }
  ranges.push({label,startPage:start.physicalPage,boundaryPage:boundary.physicalPage,startUtf16:start.offset,boundaryUtf16:boundary.offset,boundaryLabel:boundary.label});
 }
 const selectedPages=ordered.filter(p=>selected.has(p.physicalPage));
 if(selectedPages.length>14||selectedPages.reduce((n,p)=>n+Buffer.byteLength(p.body),0)>FOCUSED_TEXT_LIMITS.bodyUtf8Bytes)return unavailable('section-text-limit');
 return {...result,status:'available',ranges,pages:selectedPages.map(p=>({physicalPage:p.physicalPage,evidenceId:p.evidenceId,bodySha256:focusedTextQueryHash(p.body)}))};
}

/** A literal page is a physical-page candidate, not a verified printed label.
 * Ambiguous lists/ranges stay on ordinary retrieval. Ignore title digits. */
export function explicitDocumentPage(question:string,title:string):number|null{
 const residual=focusedDocumentTextQuery(question,title);
 if(!residual)return null;
 const matches=[...residual.matchAll(/\bpage\s+([1-9]\d*)\b|第\s*([1-9]\d*)\s*页/giu)];
 if(!matches.length)return null;
 for(const match of matches){
  const tail=residual.slice(match.index!+match[0].length);
  if(/^(?:\.\d|\s*(?:[-–—,/]\s*\d|(?:and|to)\s+\d))/iu.test(tail))return null;
 }
 const pages=[...new Set(matches.map(match=>Number(match[1]??match[2])))];
 return pages.length===1&&Number.isSafeInteger(pages[0])?pages[0]:null;
}

const compactLiteral=(value:string)=>value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
const specificLiteral=(value:string)=>Array.from(value).length<=160&&
 ((compactLiteral(value).length>=16&&(value.match(/[\p{L}\p{N}]+/gu)?.length??0)>=3)||(value.match(/\p{Script=Han}/gu)?.length??0)>=8);
/** User-supplied literal only. It is a page locator, never a verified heading. */
export function documentQuotedLiteral(question:string,title:string):string|null{
 const residual=focusedDocumentTextQuery(question,title);if(!residual)return null;
 const candidates=[...residual.matchAll(/"([^"\n]{1,200})"|“([^”\n]{1,200})”|「([^」\n]{1,200})」/gu)]
  .map(match=>(match[1]??match[2]??match[3]).trim()).filter(specificLiteral),unique=new Map(candidates.map(value=>[compactLiteral(value),value]));
 return unique.size===1?[...unique.values()][0]:null;
}
export type DocumentQuotedTextLocation={policy:'literal-quoted-text-candidates-v1';literalSha256:string;
 status:'available'|'unavailable';reason:string|null;semanticsVerified:false;adjacentPageRelationship:'unknown';
 pages:Array<{physicalPage:number;evidenceId:string;bodySha256:string;role:'literal-match-candidate'|'next-page-candidate'}>};
/** Match despite lost whitespace without rewriting text or claiming section
 * membership. A following physical page is just an explicitly unknown neighbor. */
export function locateDocumentQuotedText(literal:string,pages:Array<{physicalPage:number;evidenceId:string;body:string}>):DocumentQuotedTextLocation{
 const result:DocumentQuotedTextLocation={policy:'literal-quoted-text-candidates-v1',literalSha256:focusedTextQueryHash(literal),
  status:'unavailable',reason:null,semanticsVerified:false,adjacentPageRelationship:'unknown',pages:[]};
 const unavailable=(reason:string)=>({...result,reason});
 if(!specificLiteral(literal))return unavailable('literal-not-specific');
 if(!pages.length||pages.length>512||pages.some((page,index)=>page.physicalPage!==index+1||!page.evidenceId)||
  new Set(pages.map(page=>page.evidenceId)).size!==pages.length)return unavailable('incomplete-page-sequence');
 if(pages.reduce((n,page)=>n+Buffer.byteLength(page.body),0)>262144)return unavailable('source-text-byte-limit');
 const needle=compactLiteral(literal);let found=-1;
 for(const[index,page]of pages.entries()){
  const body=compactLiteral(page.body),position=body.indexOf(needle);if(position<0)continue;
  if(found>=0||body.indexOf(needle,position+1)>=0)return unavailable('ambiguous-literal');found=index;
 }
 if(found<0)return unavailable('literal-not-found');
 return {...result,status:'available',pages:pages.slice(found,found+2).map((page,index)=>({physicalPage:page.physicalPage,
  evidenceId:page.evidenceId,bodySha256:focusedTextQueryHash(page.body),role:index?'next-page-candidate':'literal-match-candidate'}))};
}

/** Only an explicit integer figure label; title digits, ranges and multiple
 * labels cannot silently become a single requested object. */
export function explicitDocumentFigure(question:string,title:string):number|null{
 const residual=focusedDocumentTextQuery(question,title);if(!residual)return null;
 const matches=[...residual.matchAll(/\b(?:figure|fig\.?)\s*([1-9]\d*)\b|图\s*([1-9]\d*)/giu)];
 if(!matches.length)return null;
 for(const match of matches)if(/^(?:\.\d|\s*(?:[-–—,/]\s*\d|(?:and|to)\s+\d|、\s*\d))/iu.test(residual.slice(match.index!+match[0].length)))return null;
 const figures=[...new Set(matches.map(match=>Number(match[1]??match[2])))];
 return figures.length===1&&Number.isSafeInteger(figures[0])&&figures[0]<=9999?figures[0]:null;
}
export type DocumentFigureLocation={policy:'literal-figure-caption-candidate-v1';figureNumber:number;
 status:'available'|'unavailable';reason:string|null;semanticsVerified:false;figureRegionRelationship:'unknown';
 pages:Array<{physicalPage:number;evidenceId:string;bodySha256:string;role:'caption-match-candidate'}>};
export type DocumentFigureCaptionCandidate={policy:'explicit-current-figure-page-v1';source:DocumentContextSource;figureNumber:number;
 physicalPage:number;evidenceId:string;bodySha256:string;semanticsVerified:false;figureRegionRelationship:'unknown'};
export function documentFigureCaptionCount(figureNumber:number,body:string):number{
 if(!Number.isSafeInteger(figureNumber)||figureNumber<1||figureNumber>9999)return 0;
 const caption=new RegExp(`^\\s*(?:figure|fig\\.?|图)\\s*${figureNumber}(?:\\s*[:：]\\s*\\S|\\.\\s+[^\\d\\s])`,'gimu');
 return [...body.normalize('NFKC').matchAll(caption)].length;
}
/** A unique line-start caption is a page candidate, never proof of which
 * region it describes. References in prose are not caption observations. */
export function locateDocumentFigureCaption(figureNumber:number,pages:Array<{physicalPage:number;evidenceId:string;body:string}>):DocumentFigureLocation{
 const result:DocumentFigureLocation={policy:'literal-figure-caption-candidate-v1',figureNumber,status:'unavailable',reason:null,
  semanticsVerified:false,figureRegionRelationship:'unknown',pages:[]};
 const unavailable=(reason:string)=>({...result,reason});
 if(!Number.isSafeInteger(figureNumber)||figureNumber<1||figureNumber>9999)return unavailable('invalid-figure-label');
 if(!pages.length||pages.length>512||pages.some((page,index)=>page.physicalPage!==index+1||!page.evidenceId)||
  new Set(pages.map(page=>page.evidenceId)).size!==pages.length)return unavailable('incomplete-page-sequence');
 if(pages.reduce((n,page)=>n+Buffer.byteLength(page.body),0)>262144)return unavailable('source-text-byte-limit');
 let found:typeof pages[number]|undefined;
 for(const page of pages){
  const count=documentFigureCaptionCount(figureNumber,page.body);if(!count)continue;
  if(found||count!==1)return unavailable('ambiguous-caption');found=page;
 }
 if(!found)return unavailable('caption-not-found');
 return {...result,status:'available',pages:[{physicalPage:found.physicalPage,evidenceId:found.evidenceId,
  bodySha256:focusedTextQueryHash(found.body),role:'caption-match-candidate'}]};
}
