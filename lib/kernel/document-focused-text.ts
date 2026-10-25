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
 const caption=new RegExp(`^\\s*(?:figure|fig\\.?|图)\\s*${figureNumber}(?:\\s*[:：]\\s*\\S|\\.\\s+[^\\d\\s])`,'gimu');
 let found:typeof pages[number]|undefined;
 for(const page of pages){
  const matches=[...page.body.normalize('NFKC').matchAll(caption)];if(!matches.length)continue;
  if(found||matches.length!==1)return unavailable('ambiguous-caption');found=page;
 }
 if(!found)return unavailable('caption-not-found');
 return {...result,status:'available',pages:[{physicalPage:found.physicalPage,evidenceId:found.evidenceId,
  bodySha256:focusedTextQueryHash(found.body),role:'caption-match-candidate'}]};
}
