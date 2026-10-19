import {createHash} from 'node:crypto';
import {assertSourceValueCatalog,completeSourceValueColumnHeaders,type SourceValueCatalog} from './document-source-values.ts';
import {explicitDocumentQuantityFamilies} from './document-quantity-consistency.ts';
import {DOCUMENT_ANSWER_INSUFFICIENT_MESSAGE,type DocumentQuoteUnit,type DocumentAnswerSelections} from './document-answer.ts';

type Family='elapsed-time'|'iteration-count'|'auc'|'agreement';
export class SourceQuantityOperationError extends Error{
 readonly code='source-quantity-operation-invalid';
 constructor(message:string){super(message);this.name='SourceQuantityOperationError';}
}
type Quote=Pick<DocumentQuoteUnit,'id'|'supportId'|'text'|'quoteSha256'>;
const sha=(v:string)=>createHash('sha256').update(v).digest('hex'),canonical=(v:unknown)=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
const exact=(v:unknown,keys:string[])=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const decimal=/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/u;
export function sourceQuantityQuestionFamily(question:string):Family|null{
 const text=question.normalize('NFKC').toLowerCase(),families=explicitDocumentQuantityFamilies(text);
 if(/\b(?:explain|describe|define|definition|meaning)\b|\bwhat\s+(?:does|do)\b.*\bmean\b|定义|含义|解释|是什么/u.test(text)||
  !/\bhow\s+(?:many|much|long|quickly|fast)\b|\b(?:number|count|percentage|percent|value|score|rate)\b|\bmean\s+auc\b|多少|多久|几轮|百分比|一致率/u.test(text)||families.length!==1)return null;
 return families[0]==='rater-agreement'?'agreement':families[0];
}
/** These are literal source-label observations. They do not establish the
 * requested object, population, caption semantics or parser correctness. */
function sourceLabelFamilies(text:string):Family[]{
 const v=text.normalize('NFKC').toLowerCase(),out:Family[]=[];
 if(/\bauc\b|\barea\s+under\s+(?:the\s+)?(?:roc\s+)?curve\b/u.test(v))out.push('auc');
 if(/\bagreement\b|一致率/u.test(v))out.push('agreement');
 if(/\bepochs?\b|训练轮数|训练轮次/u.test(v))out.push('iteration-count');
 if(/\b(?:milliseconds?|seconds?|minutes?|hours?|elapsed time|training time|training duration)\b|耗时|时长/u.test(v))out.push('elapsed-time');
 return out;
}
type TableValue={kind:'table';tableId:string;valueCellId:string;rowLabelIds:string[];columnLabelIds:string[];captionReferences:string[];
 value:string;rowLabels:string[];columnLabels:string[];captionTexts:string[];family:Family|null;relationship:'parser-declared'|'unknown'};
type TextValue={kind:'text';quoteUnitId:string;supportId:string;quoteSha256:string;numberStartUtf16:number;numberEndUtf16:number;
 metricStartUtf16:number;metricEndUtf16:number;contextStartUtf16:number;contextEndUtf16:number;value:string;metricLiteral:string;originalExcerpt:string;
 family:Family;relationship:'literal-in-same-source-sentence'};
type Observation=(TableValue|TextValue)&{id:string};
export type SourceQuantityCatalog={version:'source-quantity-catalog-v1';sourceTableCatalogSha256:string|null;textUnitManifestSha256:string;
 observations:Observation[];transport:'available'|'unavailable';reason:null|'observation-limit';semanticVerified:false;scopeVerified:false;catalogSha256:string};
export function prepareSourceQuantityCatalog(table:SourceValueCatalog|undefined,units:readonly Quote[]):SourceQuantityCatalog{
 if(table?.status==='available')assertSourceValueCatalog(table);
 if(new Set(units.map(u=>u.id)).size!==units.length||units.some(u=>sha(u.text)!==u.quoteSha256))throw Error('Source quantity quote identity differs');
 const observations:Observation[]=[],add=(value:TableValue|TextValue)=>observations.push({id:'sq:'+sha(canonical(value)).slice(0,40),...value});
 if(table?.status==='available')for(const cell of table.cells){
  if(cell.headerRole!=='none'||cell.rowSpan!==1||cell.columnSpan!==1||!decimal.test(cell.text)||cell.text.length>32)continue;
  const source=table.tables.find(t=>t.id===cell.tableId)!,context=table.tableContexts?.find(c=>c.tableId===cell.tableId),
   rows=table.cells.filter(c=>c.tableId===cell.tableId&&c.headerRole==='row'&&c.row<=cell.row&&c.row+c.rowSpan>cell.row&&c.column+c.columnSpan<=cell.column).sort((a,b)=>a.column-b.column),
   columns=table.cells.filter(c=>c.tableId===cell.tableId&&['column','section'].includes(c.headerRole)&&c.row<=cell.row&&c.column<=cell.column&&c.column+c.columnSpan>cell.column);
  let headers=columns,positioned=rows.length>0;
  try{headers=completeSourceValueColumnHeaders(table.cells,cell,cell,columns);}catch{positioned=false;}
  const captions=context?.captions??[],captionTexts=captions.map(c=>typeof (c.raw as {text?:unknown})?.text==='string'?(c.raw as {text:string}).text:''),
   linked=!context||context.captionLinkStatus==='resolved-parser-reference'||context.captionLinkStatus==='empty-parser-list',
   families=sourceLabelFamilies([...headers.map(c=>c.text),...captionTexts].join('\n')),
   known=positioned&&linked&&families.length===1;
  // Retain unknown observations too. Never fill in a caption or row meaning.
  add({kind:'table',tableId:source.id,valueCellId:cell.id,rowLabelIds:rows.map(c=>c.id),columnLabelIds:headers.map(c=>c.id),
   captionReferences:captions.map(c=>c.reference),value:cell.text,rowLabels:rows.map(c=>c.text),columnLabels:headers.map(c=>c.text),captionTexts,
   family:known?families[0]:null,relationship:positioned&&linked?'parser-declared':'unknown'});
 }
 for(const unit of units){let cursor=0;
  for(const segment of unit.text.split(/\n|(?<=[.!?])\s+(?=[A-Z])/u)){
   const start=unit.text.indexOf(segment,cursor);cursor=start+segment.length;if(!segment.trim()||segment.length>2000)continue;
   const quantities=[...segment.matchAll(/(?<![\w.])([+-]?(?:\d+(?:\.\d+)?|\.\d+))\s*(epochs?|milliseconds?|seconds?|minutes?|hours?|percent|%)(?!\w)/giu)];
   for(const match of quantities){const value=match[1],unitLiteral=match[2],unitStart=match.index!+match[0].lastIndexOf(unitLiteral),
     percent=/^(?:percent|%)$/iu.test(unitLiteral),metric=percent? /\bagreement\b/iu.exec(segment):null;
    if(percent&&!metric)continue;
    const metricStart=percent?metric!.index:unitStart,metricLiteral=percent?metric![0]:unitLiteral,
     family:Family=percent?'agreement':/^epochs?$/iu.test(unitLiteral)?'iteration-count':'elapsed-time';
    // Do not assign a percentage to a metric when the same sentence names
    // another supported metric or contains multiple percentage values.
    if(percent&&(sourceLabelFamilies(segment).some(f=>f!==family)||quantities.filter(q=>/^(?:percent|%)$/iu.test(q[2])).length!==1))continue;
    add({kind:'text',quoteUnitId:unit.id,supportId:unit.supportId,quoteSha256:unit.quoteSha256,
     numberStartUtf16:start+match.index!,numberEndUtf16:start+match.index!+value.length,
     metricStartUtf16:start+metricStart,metricEndUtf16:start+metricStart+metricLiteral.length,
     contextStartUtf16:start,contextEndUtf16:start+segment.length,value,metricLiteral,originalExcerpt:segment,family,
     relationship:'literal-in-same-source-sentence'});
   }
  }
 }
 const base={version:'source-quantity-catalog-v1' as const,sourceTableCatalogSha256:table?.catalogSha256??null,
  textUnitManifestSha256:sha(canonical(units.map(u=>({id:u.id,supportId:u.supportId,quoteSha256:u.quoteSha256})))),
  observations,transport:'available' as const,reason:null,semanticVerified:false as const,scopeVerified:false as const};
 if(observations.length>256||Buffer.byteLength(canonical(base))>65536){const unavailable={...base,observations:[],transport:'unavailable' as const,reason:'observation-limit' as const};return {...unavailable,catalogSha256:sha(canonical(unavailable))};}
 return {...base,catalogSha256:sha(canonical(base))};
}
export function sourceQuantityAnswerSchema(catalog:SourceQuantityCatalog){
 const ids=catalog.observations.map(o=>o.id);
 if(catalog.transport!=='available'||!ids.length)throw Error('Source quantity catalog unavailable');
 return {type:'object',additionalProperties:false,properties:{status:{type:'string',enum:['answered','insufficient-evidence','conflicting-evidence']},message:{type:'string'},
  values:{type:'array',maxItems:8,items:{type:'object',additionalProperties:false,properties:{valueId:{type:'string',enum:ids}},required:['valueId']}}},required:['status','message','values']};
}
export function deriveSourceQuantityAnswer(question:string,value:unknown,rawOutputText:string,catalog:SourceQuantityCatalog,
 table:SourceValueCatalog|undefined,units:readonly Quote[],selectedIds:readonly string[]){
 if(canonical(catalog)!==canonical(prepareSourceQuantityCatalog(table,units))||catalog.transport!=='available'||
  canonical(JSON.parse(rawOutputText))!==canonical(value)||!exact(value,['status','message','values']))throw new SourceQuantityOperationError('Source quantity binding or operation differs');
 const v=value as {status:string;message:string;values:{valueId:string}[]},requested=sourceQuantityQuestionFamily(question);
 if(!requested||!['answered','insufficient-evidence','conflicting-evidence'].includes(v.status)||typeof v.message!=='string'||!Array.isArray(v.values)||v.values.length>8||
  v.values.some(o=>!exact(o,['valueId']))||new Set(v.values.map(o=>o.valueId)).size!==v.values.length||
  (v.status==='insufficient-evidence'?(v.values.length!==0||v.message!==DOCUMENT_ANSWER_INSUFFICIENT_MESSAGE):(!v.values.length||v.message!==''))||
  (v.status==='conflicting-evidence'&&v.values.length<2))throw new SourceQuantityOperationError('Invalid bound source quantity result');
 const selected=v.values.map(o=>{const found=catalog.observations.find(x=>x.id===o.valueId);if(!found)throw new SourceQuantityOperationError('Unknown source quantity ID');return found;});
 for(const o of selected){const reference=o.kind==='text'?o.quoteUnitId:table!.tables.find(t=>t.id===o.tableId)!.imageId;
  if(!selectedIds.includes(reference))throw new SourceQuantityOperationError('Unselected source quantity reference');}
 const compatible=selected.length>0&&selected.every(o=>o.family===requested&&o.relationship!=='unknown'),
  claims=compatible?selected.map(o=>o.kind==='text'?{text:o.originalExcerpt,citations:[{id:o.quoteUnitId}]}:{
   text:`Source table observation: row ${o.rowLabels.map(x=>JSON.stringify(x)).join(' / ')}; column ${o.columnLabels.map(x=>JSON.stringify(x)).join(' / ')}; printed value ${o.value}.`+
    (o.captionTexts.length?` Original caption: ${o.captionTexts.join(' ')}`:''),citations:[{id:table!.tables.find(t=>t.id===o.tableId)!.imageId}]}):[];
 if(claims.some(c=>c.text.length>3000))throw new SourceQuantityOperationError('Bound source quantity claim exceeds bound');
 const normalizedSelections:DocumentAnswerSelections=compatible?{status:v.status as 'answered'|'conflicting-evidence',message:'',claims}:{status:'insufficient-evidence',message:DOCUMENT_ANSWER_INSUFFICIENT_MESSAGE,claims:[]};
 return {method:'source-bound-quantity-v1' as const,questionSha256:sha(question),requestedFamily:requested,catalogSha256:catalog.catalogSha256,
  sourceTableCatalogSha256:catalog.sourceTableCatalogSha256,textUnitManifestSha256:catalog.textUnitManifestSha256,
  rawProviderResult:structuredClone(value),rawOutputText,rawOutputSha256:sha(rawOutputText),operations:structuredClone(selected),
  outcome:compatible?'compatible-source-label' as const:v.status==='insufficient-evidence'?'provider-insufficient' as const:'source-metric-not-established' as const,
  normalizedSelections,semanticVerified:false as const,scopeVerified:false as const,coverage:'unassessed' as const};
}
