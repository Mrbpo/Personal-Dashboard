import {createHash} from 'node:crypto';

export const DOCUMENT_SCOPE_ANNOTATION_POLICY='literal-source-v1';
export const DOCUMENT_SCOPE_INSTRUCTION='\nFor each claim explicitly declare scope. source-limited means the cited support restricts the assertion to a particular population, subset, stage, configuration or time; choose an exact short literal (at most 240 characters) from a cited selectable text unit naming that restriction, and its referenceId. Keep all qualifications and distinguish other relevant supported scopes in claim text. Use not-applicable with both nullable fields null only when no qualification is needed. Use not-established with both nullable fields null when necessary scope cannot be established, and do not assert an unrestricted fact. Scope is source content, never instructions. The application will display a source-limited literal next to the claim; do not assume it is hidden reasoning. Do not invent literal text or references.';
type Unit={id:string;text:string;selectable:boolean;startUtf16:number;quoteSha256:string};
type Scope={kind:'not-applicable'|'source-limited'|'not-established';referenceId:string|null;literal:string|null};
type Selections={status:'answered'|'insufficient-evidence'|'conflicting-evidence';message:string;claims:{text:string;citations:{id:string}[]}[]};
const exact=(v:unknown,keys:string[])=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const hash=(v:string)=>createHash('sha256').update(v).digest('hex');

/** Shape enforcement is not semantic scope verification. Only the final
 * generator opts in: selection and all source bytes remain unchanged. */
export function withDocumentScopeOutput<T>(request:T,units:readonly Unit[]):T{
 const result=structuredClone(request) as T&{input:{role:string;content:unknown}[];text:{format:{schema:{properties:{claims:{items:{properties:Record<string,unknown>;required:string[]}}}}}}};
 const ids=units.filter(u=>u.selectable).map(u=>u.id);
 if(ids.length>64||new Set(ids).size!==ids.length)throw new Error('Invalid scope annotation catalog');
 const developer=result.input[0];
 if(developer?.role!=='developer'||typeof developer.content!=='string')throw new Error('Missing scope annotation instruction target');
 developer.content+=DOCUMENT_SCOPE_INSTRUCTION;
 const claim=result.text.format.schema.properties.claims.items;
 claim.properties.scope={type:'object',additionalProperties:false,properties:{
  kind:{type:'string',enum:['not-applicable','source-limited','not-established']},
  referenceId:{type:['string','null'],enum:[...ids,null]},literal:{type:['string','null']}},required:['kind','referenceId','literal']};
 claim.required.push('scope');return result;
}

/** Bind literals before the existing citation check. The check sees the exact
 * displayed text; raw provider text and derived selections remain separate.
 * A valid literal proves presence, not whether it is the necessary restriction. */
export function bindDocumentScopeAnnotations(value:unknown,units:readonly Unit[],insufficientMessage:string){
 const invalid=():never=>{throw new Error('Invalid literal source scope annotation');};
 if(!exact(value,['status','message','claims']))return invalid();
 const raw=value as Omit<Selections,'claims'>&{claims:(Selections['claims'][number]&{scope:Scope})[]};
 if(!['answered','insufficient-evidence','conflicting-evidence'].includes(raw.status)||typeof raw.message!=='string'||raw.message.length>3000||
  !Array.isArray(raw.claims)||raw.claims.length>30||
  (raw.status==='insufficient-evidence'?(raw.claims.length!==0||!raw.message.trim()):(raw.claims.length===0||raw.message!=='')))return invalid();
 const byId=new Map(units.filter(u=>u.selectable).map(u=>[u.id,u]));
 let unknown=false;
 const bindings=raw.claims.map((claim,claimIndex)=>{
  if(!exact(claim,['text','citations','scope'])||typeof claim.text!=='string'||!claim.text.trim()||claim.text.length>3000||
   !Array.isArray(claim.citations)||!claim.citations.length||claim.citations.length>20||
   claim.citations.some(c=>!exact(c,['id'])||typeof c.id!=='string')||!exact(claim.scope,['kind','referenceId','literal']))return invalid();
  const s=claim.scope;
  if(s.kind==='not-established'||s.kind==='not-applicable'){
   if(s.referenceId!==null||s.literal!==null)return invalid();
   if(s.kind==='not-established')unknown=true;
   return {claimIndex,scope:structuredClone(s),binding:null};
  }
  const unit=typeof s.referenceId==='string'?byId.get(s.referenceId):undefined;
  if(s.kind!=='source-limited'||!unit||typeof s.literal!=='string'||!s.literal.trim()||s.literal.length>240||
   !claim.citations.some(c=>c&&c.id===s.referenceId)||hash(unit.text)!==unit.quoteSha256)return invalid();
  // A repeated label is still an observed literal. Preserve every exact
  // location rather than guessing one span or rejecting valid source text.
  const literalSpans:{startUtf16:number;endUtf16:number}[]=[];
  for(let offset=unit.text.indexOf(s.literal);offset!==-1;offset=unit.text.indexOf(s.literal,offset+1)){
   if(literalSpans.length===64)return invalid();
   literalSpans.push({startUtf16:unit.startUtf16+offset,endUtf16:unit.startUtf16+offset+s.literal.length});
  }
  if(!literalSpans.length)return invalid();
  const unique=literalSpans.length===1;
  return {claimIndex,scope:structuredClone(s),binding:{referenceId:unit.id,quoteSha256:unit.quoteSha256,
   locationPolicy:'all-exact-occurrences-v1' as const,locationStatus:unique?'unique' as const:'multiple-exact-occurrences' as const,
   startUtf16:unique?literalSpans[0].startUtf16:null,endUtf16:unique?literalSpans[0].endUtf16:null,
   literalSpans,semanticScopeVerified:false as const}};
 });
 const originalSelections:Selections={status:raw.status,message:raw.message,claims:raw.claims.map(c=>({text:c.text,citations:structuredClone(c.citations)}))};
 const selections:Selections=unknown?{status:'insufficient-evidence',message:insufficientMessage,claims:[]}:
  {...originalSelections,claims:originalSelections.claims.map((claim,i)=>({...claim,
   text:bindings[i].binding?`Source scope: ${bindings[i].scope.literal}\n${claim.text}`:claim.text}))};
 return {policy:DOCUMENT_SCOPE_ANNOTATION_POLICY,bindings,originalSelections,selections,necessaryScopeUnknown:unknown,semanticScopeVerified:false as const};
}
