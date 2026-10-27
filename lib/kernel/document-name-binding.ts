import{createHash}from'node:crypto';import type{Pool}from'pg';
import{readDocumentNodes}from'./document-nodes.ts';
import{DocumentEvidenceChangedError}from'./document-evidence.ts';
import type{DocumentContextSource}from'./document-context.ts';

type Span={startUtf16:number;endUtf16:number;text:string};
export type DocumentQuestionNameRequest={role:'subject'|'comparator'|'intervention'|'condition';questionName:Span;
 candidate:{evidenceId:string;span:Span};definition?:{evidenceId:string;longName:Span;shortName:Span}};
export const DOCUMENT_NAME_BINDING_VERSION='source-bound-name-observation-v1';
const sha=(v:unknown)=>createHash('sha256').update(typeof v==='string'?v:JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?
 Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x)).digest('hex'),
 exact=(v:unknown,keys:string[])=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k)),
 bounded=(v:unknown):v is string=>typeof v==='string'&&!!v.trim()&&v.length<=4000,
 name=(v:string)=>v.trim().replace(/\s+/gu,' ');
export class DocumentNameBindingError extends Error{readonly code='DOCUMENT_NAME_BINDING_INVALID';constructor(){super('Name binding requires exact question and original-source spans');this.name='DocumentNameBindingError';}}
const invalid=():never=>{throw new DocumentNameBindingError();};
function spanShape(v:unknown):v is Span{return exact(v,['startUtf16','endUtf16','text'])&&
 Number.isSafeInteger((v as Span).startUtf16)&&Number.isSafeInteger((v as Span).endUtf16)&&(v as Span).startUtf16>=0&&
 (v as Span).endUtf16>(v as Span).startUtf16&&bounded((v as Span).text)&&(v as Span).text.length<=1000&&
 (v as Span).text.length===(v as Span).endUtf16-(v as Span).startUtf16;}
function assertSpan(body:string,s:Span){
 if(s.endUtf16>body.length||body.slice(s.startUtf16,s.endUtf16)!==s.text)invalid();
 for(const p of[s.startUtf16,s.endUtf16])if(p>0&&p<body.length&&/[\uD800-\uDBFF]/u.test(body[p-1])&&/[\uDC00-\uDFFF]/u.test(body[p]))invalid();
}
function independentNameSpan(body:string,s:Span){
 const before=body.slice(Math.max(0,s.startUtf16-3),s.startUtf16),after=body.slice(s.endUtf16,s.endUtf16+3),connected=/[\p{L}\p{N}\p{M}_+\/-]/u,
  first=Array.from(s.text.slice(0,2))[0]??'',last=Array.from(s.text.slice(-2)).at(-1)??'';
 return !(connected.test(first)&&(connected.test(Array.from(before).at(-1)??'')||/[\p{L}\p{N}]\.$/u.test(before)))&&
  !(connected.test(last)&&(connected.test(Array.from(after)[0]??'')||/^\.[\p{L}\p{N}]/u.test(after)));
}
export function validateDocumentQuestionNameRequest(question:string,input:unknown):DocumentQuestionNameRequest{
 if(typeof question!=='string'||!question.trim()||question.length>16000||!input||typeof input!=='object'||Array.isArray(input))invalid();
 const r=structuredClone(input)as DocumentQuestionNameRequest;
 if(!exact(r,['role','questionName','candidate',...(Object.hasOwn(r,'definition')?['definition']:[])])||
  !['subject','comparator','intervention','condition'].includes(r.role)||!spanShape(r.questionName)||
  !exact(r.candidate,['evidenceId','span'])||!bounded(r.candidate.evidenceId)||!spanShape(r.candidate.span))invalid();
 assertSpan(question,r.questionName);
 if(r.definition&&(!exact(r.definition,['evidenceId','longName','shortName'])||!bounded(r.definition.evidenceId)||
  !spanShape(r.definition.longName)||!spanShape(r.definition.shortName)))invalid();
 if(Object.hasOwn(r,'definition')&&!r.definition)invalid();return r;
}

/** Verify a local written naming form, never semantic entity equivalence. The
 * candidate must be a defining occurrence; no later abbreviation is rebound. */
export async function bindDocumentQuestionName(pool:Pool,owner:string,expected:DocumentContextSource,question:string,input:unknown){
 const source=structuredClone(expected),r=validateDocumentQuestionNameRequest(question,input),
  ids=[...new Set([r.candidate.evidenceId,...(r.definition?[r.definition.evidenceId]:[])])],nodes=await readDocumentNodes(pool,owner,source,ids),
  selected=nodes.find(n=>n.evidence_id===r.candidate.evidenceId)!;
 assertSpan(selected.body,r.candidate.span);
 let status:'observed-literal'|'observed-initialism'|'unresolved'='unresolved',reason='different-complete-names';
 let definitionBinding:unknown=null;
 if(r.definition){
  const d=r.definition,node=nodes.find(n=>n.evidence_id===d.evidenceId)!;assertSpan(node.body,d.longName);assertSpan(node.body,d.shortName);
  definitionBinding={evidenceId:d.evidenceId,bodySha256:sha(node.body),longName:d.longName,shortName:d.shortName};
 }
 if(!independentNameSpan(question,r.questionName)||!independentNameSpan(selected.body,r.candidate.span))reason='non-independent-name-span';
 else if(name(r.questionName.text)===name(r.candidate.span.text)){status='observed-literal';reason='same-case-sensitive-complete-span';}
 else if(r.definition){
  const d=r.definition,node=nodes.find(n=>n.evidence_id===d.evidenceId)!,tokens=d.longName.text.match(/[\p{L}\p{M}]+/gu)??[],
   initials=tokens.map(t=>Array.from(t)[0]).join('').toUpperCase(),short=d.shortName.text,
   adjacent=d.longName.endUtf16<=d.shortName.startUtf16&&/^\s*\(\s*$/u.test(node.body.slice(d.longName.endUtf16,d.shortName.startUtf16))&&
    /^\s*\)/u.test(node.body.slice(d.shortName.endUtf16)),
   sameOccurrence=d.evidenceId===r.candidate.evidenceId&&[d.longName,d.shortName].some(s=>s.startUtf16===r.candidate.span.startUtf16&&s.endUtf16===r.candidate.span.endUtf16&&s.text===r.candidate.span.text),
   wholeName=[d.longName.text,d.shortName.text].some(s=>name(s)===name(r.questionName.text));
  if(tokens.length>=2&&tokens.length<=12&&/^[A-Z][A-Z0-9]{1,11}$/.test(short)&&initials===short&&adjacent&&sameOccurrence&&wholeName&&
   independentNameSpan(node.body,d.longName)&&independentNameSpan(node.body,d.shortName)){
   status='observed-initialism';reason='local-source-declared-initialism';
  }else reason='no-supported-local-name-declaration';
 }
 const stamp=(rows:typeof nodes)=>sha(rows.map(n=>[n.id,n.evidence_id,n.source_version_id,n.source_hash,n.body]));
 if(stamp(await readDocumentNodes(pool,owner,source,ids))!==stamp(nodes))throw new DocumentEvidenceChangedError();
 const value={version:DOCUMENT_NAME_BINDING_VERSION,owner,questionSha256:sha(question),role:r.role,requested:r.questionName,status,reason,
  source,sourceLabel:{evidenceId:selected.evidence_id,locator:selected.locator,parserVersion:selected.parser_version,
   parserWarnings:selected.parser_warnings??[],bodySha256:sha(selected.body),span:r.candidate.span},definition:definitionBinding,
  normalization:'whitespace-only-case-sensitive',authority:'stored-source-name-observation',semanticIdentityVerified:false,
  globalEntityMergeAuthorized:false,unknownProvesUnanswerable:false};
 return{...value,observationSha256:sha(value)};
}
