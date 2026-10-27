import {createHash} from 'node:crypto';
import {DOCUMENT_ANSWER_INSUFFICIENT_MESSAGE} from './document-answer.ts';
import type {GroundedDocumentAnswer} from './document-answer.ts';

type Quantity='elapsed-time'|'iteration-count'|'auc'|'rater-agreement';
const normalized=(text:string)=>text.normalize('NFKC').toLowerCase();
function families(text:string):Quantity[]{
 const found:Quantity[]=[];
 if(/\b(?:training\s+(?:time|duration)|elapsed\s+time|how\s+much\s+time)\b|\bhow\s+(?:long|quickly|fast)\b.{0,80}\b(?:train\w*|take|last|run)\b|耗时|时长|多久|训练时间/u.test(text))found.push('elapsed-time');
 if(/\bepochs?\b|训练轮数|训练轮次|\d\s*轮/u.test(text))found.push('iteration-count');
 if(/\bauc\b|\barea\s+under\s+(?:the\s+)?(?:roc\s+)?curve\b/u.test(text))found.push('auc');
 if(/\b(?:(?:inter[ -]?)?(?:rater|annotator)s?|human(?:\s+judgment)?)\b.{0,60}\bagreement\b|\bagreement\b.{0,60}\b(?:raters?|annotators?|humans?)\b|(?:人工|人类|标注者|评审者).{0,20}一致(?:率|性|程度)/u.test(text))found.push('rater-agreement');
 return found;
}
function explicitClaimFamilies(text:string){
 const found=families(text);
 if(/\d(?:[\d.,]*\d)?\s*(?:milliseconds?|seconds?|minutes?|hours?|days?)\b|\d\s*(?:毫秒|秒钟?|分钟|小时|天)/u.test(text)&&!found.includes('elapsed-time'))found.push('elapsed-time');
 return found;
}
/** Question-side recognition only; never use question labels as source facts. */
export function explicitDocumentQuantityFamilies(text:string){return families(normalized(text));}
const incompatible=(a:Quantity,b:Quantity)=>
 (a==='elapsed-time'&&b==='iteration-count')||(b==='elapsed-time'&&a==='iteration-count')||
 (a==='rater-agreement'&&b==='auc')||(b==='rater-agreement'&&a==='auc');

/** A limited contradiction check, not an answerability or source-support judge.
 * Only an explicit, exclusive incompatible quantity can block the whole answer.
 * Unknown, mixed and implicit quantities stay unassessed; no value or source
 * label is inferred, no partial answer is edited and no claim is certified. */
export function checkDocumentQuantityConsistency(question:string,answer:GroundedDocumentAnswer){
 const text=normalized(question),requested=families(text),
  quantitative=/\b(?:what|how|number|count|percentage|percent|rate|value|score)\b|多少|多久|几轮|百分比|比例|一致率/u.test(text),
  observations=answer.claims.map((claim,claimIndex)=>{const text=normalized(claim.text);return {claimIndex,
   numeric:/\d/u.test(text),families:explicitClaimFamilies(text),
   ambiguous:/\b(?:not|no|without|versus|vs)\b|没有|未报告|并非|不是/u.test(text)};}),
  blocked=answer.status==='answered'&&quantitative&&requested.length===1&&observations.length>0&&
   observations.every(o=>o.numeric&&!o.ambiguous&&o.families.length===1&&incompatible(requested[0],o.families[0]));
 const originalAnswer=structuredClone(answer),answerSha256=createHash('sha256').update(JSON.stringify(answer)).digest('hex');
 return {policy:'explicit-quantity-consistency-v1' as const,
  status:blocked?'explicit-incompatible-quantity' as const:'unassessed' as const,
  requested,observations,originalAnswerSha256:answerSha256,
  ...(blocked?{originalAnswer}:{}),sourceSupportVerified:false as const,wholeAnswerVerified:false as const,
  answer:blocked?{status:'insufficient-evidence' as const,message:DOCUMENT_ANSWER_INSUFFICIENT_MESSAGE,claims:[]}:answer};
}
