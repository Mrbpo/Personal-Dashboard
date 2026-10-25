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
