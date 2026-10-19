import {createHash} from 'node:crypto';

export const DOCUMENT_QUESTION_TARGET_VERSION='explicit-question-attribute-v1';
export type DocumentQuestionTarget={questionSpan:string;subject:string;attribute:string;unit:string|null};
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const exact=(value:unknown,keys:string[])=>!!value&&typeof value==='object'&&!Array.isArray(value)&&
 Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const text=(value:unknown,max:number)=>typeof value==='string'&&!!value.trim()&&value.length<=max;
export const documentQuestionTargetSchema={anyOf:[{type:'null'},{type:'object',additionalProperties:false,
 properties:{questionSpan:{type:'string'},subject:{type:'string'},attribute:{type:'string'},unit:{type:['string','null']}},
 required:['questionSpan','subject','attribute','unit']}]};

/** This validates shape and literal question provenance, never interpretation. */
export function validateDocumentQuestionTarget(question:string,value:unknown):DocumentQuestionTarget|null{
 if(value===null)return null;
 if(!exact(value,['questionSpan','subject','attribute','unit']))throw Error('Invalid question target');
 const target=value as DocumentQuestionTarget;
 const start=question.indexOf(target.questionSpan);
 if(!text(target.questionSpan,1000)||!text(target.subject,400)||!text(target.attribute,400)||
  !(target.unit===null||text(target.unit,80))||start<0||question.indexOf(target.questionSpan,start+1)>=0)
  throw Error('Invalid question target span or attribute');
 return {...target};
}
export type FrozenDocumentQuestionTarget=Readonly<{version:typeof DOCUMENT_QUESTION_TARGET_VERSION;questionSha256:string;
 target:Readonly<DocumentQuestionTarget>;startUtf16:number;endUtf16:number;targetSha256:string;
 providerRequestSha256:string;rawResponseSha256:string;fallible:true;semanticVerified:false}>;
const frozenTargets=new WeakSet<object>();
export function freezeDocumentQuestionTarget(question:string,value:unknown,providerRequestSha256:string,rawResponseSha256:string){
 const target=validateDocumentQuestionTarget(question,value);
 if(!target||![providerRequestSha256,rawResponseSha256].every(h=>/^[a-f0-9]{64}$/.test(h)))throw Error('Missing question target provenance');
 const startUtf16=question.indexOf(target.questionSpan),frozen:FrozenDocumentQuestionTarget=Object.freeze({
  version:DOCUMENT_QUESTION_TARGET_VERSION,questionSha256:hash(question),target:Object.freeze(target),startUtf16,
  endUtf16:startUtf16+target.questionSpan.length,targetSha256:hash(JSON.stringify(target)),providerRequestSha256,rawResponseSha256,
  fallible:true,semanticVerified:false});
 frozenTargets.add(frozen);return frozen;
}
export function assertDocumentQuestionTarget(question:string,target:FrozenDocumentQuestionTarget){
 if(!target||!frozenTargets.has(target)||target.questionSha256!==hash(question))throw Error('Unbound question target');
}

/** Add a direct-value slot to the existing generation call. Original evidence,
 * images, supplementary claims and original citation IDs remain available. */
export function bindDocumentQuestionTargetRequest<T extends {input:unknown[];text:unknown}>(request:T,question:string,target:FrozenDocumentQuestionTarget):T{
 assertDocumentQuestionTarget(question,target);
 const result=structuredClone(request),messages=result.input as Array<{role:string;content:string|Array<{type:string;text?:string}>}>,
  developer=messages[0],user=messages.at(-1)!;
 if(typeof developer.content!=='string'||!Array.isArray(user.content)||user.content[0]?.type!=='input_text'||typeof user.content[0].text!=='string')
  throw Error('Missing original target generation input');
 const input=JSON.parse(user.content[0].text);if(input.question!==question)throw Error('Target request question changed');
 input.questionTarget=target;user.content[0].text=JSON.stringify(input);
 developer.content+=' questionTarget is a fallible question-only interpretation frozen before reading evidence, not source evidence. '+
  'Return directAnswer for that exact subject and attribute, using one or more source-qualified value parts and actual citations. '+
  'The server will render each value as an assertion about the frozen subject and attribute and check that assertion against its citations. '+
  'A nearby reported value cannot answer a different attribute. If the interpretation is wrong, ambiguous or unsupported, return insufficient-evidence, directAnswer:null and no claims. '+
  'claims contains optional supplementary assertions; it cannot substitute for directAnswer. Keep conditional values and different source scopes explicit in each value; do not merge them.';
 const format=(result.text as {format:{schema:any}}).format,schema=format.schema,
  citations=schema.properties.claims.items.properties.citations;
 const ids=citations.items.properties.id.enum;
 if(ids.length*2+4>1000)throw Error('Target answer schema exceeds enum count');
 schema.properties.directAnswer={anyOf:[{type:'null'},{type:'object',additionalProperties:false,
  properties:{targetId:{type:'string',enum:['r0']},parts:{type:'array',items:{type:'object',additionalProperties:false,
   properties:{value:{type:'string'},citations:structuredClone(citations)},required:['value','citations']}}},required:['targetId','parts']}]};
 schema.required.push('directAnswer');return result;
}

/** Render the frozen requested relation into the actual claim that the existing
 * citation audit checks. Schema validity is not semantic answer correctness. */
export function normalizeDocumentQuestionTargetAnswer(question:string,target:FrozenDocumentQuestionTarget,value:unknown,rawOutputText:string){
 assertDocumentQuestionTarget(question,target);
 if(!exact(value,['status','message','claims','directAnswer'])||JSON.stringify(JSON.parse(rawOutputText))!==JSON.stringify(value))
  throw Error('Invalid target answer raw output');
 const v=value as {status:string;message:string;claims:unknown[];directAnswer:null|{targetId:string;parts:Array<{value:string;citations:unknown[]}>}};
 if(!['answered','insufficient-evidence','conflicting-evidence'].includes(v.status)||typeof v.message!=='string'||!Array.isArray(v.claims))
  throw Error('Invalid target answer status');
 const direct=v.directAnswer;
 if(v.status!=='answered'){
  if(direct!==null||v.claims.length)throw Error('Unsupported target answer must not publish claims');
  return {normalizedSelections:{status:v.status,message:v.message,claims:[]},receipt:{version:DOCUMENT_QUESTION_TARGET_VERSION,
   target,rawOutputText,rawOutputSha256:hash(rawOutputText),claimOrigins:[],semanticVerified:false as const}};
 }
 if(!exact(direct,['targetId','parts'])||direct!.targetId!=='r0'||!Array.isArray(direct!.parts)||!direct!.parts.length||
  direct!.parts.length+v.claims.length>30)throw Error('Answered requires direct question target values');
 const {subject,attribute,unit}=target.target;
 const claims=direct!.parts.map(part=>{
  if(!exact(part,['value','citations'])||!text(part.value,2000)||!Array.isArray(part.citations)||!part.citations.length)
   throw Error('Invalid direct target value');
  return {text:`${subject} — ${attribute}${unit?` (${unit})`:''}: ${part.value}`,citations:part.citations};
 });
 return {normalizedSelections:{status:v.status,message:v.message,claims:[...claims,...v.claims]},
  receipt:{version:DOCUMENT_QUESTION_TARGET_VERSION,target,rawOutputText,rawOutputSha256:hash(rawOutputText),
   claimOrigins:[...claims.map((_,index)=>({claimIndex:index,role:'direct-value',targetId:'r0'})),
    ...v.claims.map((_,index)=>({claimIndex:claims.length+index,role:'supplement'}))],semanticVerified:false as const}};
}
