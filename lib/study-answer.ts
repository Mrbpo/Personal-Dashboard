import {kernel} from './kernel/service.ts';
import {serviceValue} from './service-vault.ts';
import {DocumentModelResponseError,type DocumentAnswerModel} from './kernel/document-answer.ts';
import {DocumentCitationCheckError} from './kernel/document-citation-audit.ts';
import {DocumentContextError} from './kernel/document-context.ts';
import {SourceValueHeaderError} from './kernel/document-source-values.ts';
import {SourceCellBindingError} from './kernel/document-source-cell-bindings.ts';
import {SourceQuantityOperationError} from './kernel/document-source-quantities.ts';
import {assertDocumentDevelopmentRun} from './kernel/document-rerank.ts';
import {randomUUID,createHash} from 'node:crypto';
import {mkdir,open} from 'node:fs/promises';
import {isAbsolute,join} from 'node:path';
import {normalizeDocumentRoutingScope,DOCUMENT_ROUTING_SCOPE_VERSION,type DocumentRoutingScope} from './kernel/document-routing-scope.ts';
import {nativeCellDeclarationMode} from './kernel/document-table-candidates.ts';

export const STUDY_APPLICATION_VERSION='kernel-study-http-v1';
export type StudyFailureStage='configuration'|'parsing'|'structure-storage'|'retrieval'|'evidence-selection'|'generation'|'citation-validation';
export class StudyAnswerError extends Error{
 readonly stage:StudyFailureStage;readonly code:string;
 constructor(stage:StudyFailureStage,code:string,message:string,options?:ErrorOptions){super(message,options);this.name='StudyAnswerError';this.stage=stage;this.code=code;}
}
/** Server configuration only. Unknown settings must never silently select a path. */
export function studyAnswerBackend(value=process.env.STUDY_ANSWER_BACKEND??'legacy'){
 if(value!=='legacy'&&value!=='kernel')throw new StudyAnswerError('configuration','invalid-backend','学习问答路径配置无效');
 return value;
}

/** A caller restriction, not an inferred relevance classification. Legacy must
 * reject a requested restriction instead of answering from a broader corpus. */
export function studyRoutingScope(value:unknown,jsonField=false):DocumentRoutingScope|undefined{
 if(value===undefined||(jsonField&&value===null))return undefined;
 let scope:DocumentRoutingScope|undefined;
 try{
  if(jsonField){if(typeof value!=='string'||value.length>16000)throw Error('Invalid scope field');value=JSON.parse(value);}
  scope=normalizeDocumentRoutingScope(value);
  if(!scope||JSON.stringify(scope).length>16000)throw Error('Scope exceeds request bound');
 }catch(cause){throw new StudyAnswerError('configuration','invalid-routing-scope','检索范围格式无效',{cause});}
 if(studyAnswerBackend()!=='kernel')throw new StudyAnswerError('configuration','routing-requires-kernel','当前问答路径不支持指定检索范围');
 return scope;
}

export function studyRoutingScopeWitness(scope:DocumentRoutingScope|undefined){
 if(scope===undefined)return undefined;
 const value={version:DOCUMENT_ROUTING_SCOPE_VERSION,scope:normalizeDocumentRoutingScope(scope)!};
 return Object.freeze({...value,fingerprint:createHash('sha256').update(JSON.stringify(value)).digest('hex')});
}
export function studyEvidenceSelection(value=process.env.STUDY_EVIDENCE_SELECTION??'single-pass'){
 if(value!=='single-pass'&&value!=='select-then-answer')throw new StudyAnswerError('configuration','invalid-evidence-selection','证据选择配置无效');
 return value==='single-pass'?undefined:value;
}
export function studyCitationCheck(value=process.env.STUDY_CITATION_CHECK??'off'){
 if(value!=='off'&&value!=='selected-once')throw new StudyAnswerError('configuration','invalid-citation-check','引用核对配置无效');
 return value==='off'?undefined:value;
}
export function studySourceTextCitations(value=process.env.STUDY_SOURCE_TEXT_CITATIONS??'off'){
 if(value!=='off'&&value!=='current-source-view-v1')throw new StudyAnswerError('configuration','invalid-source-text-citations','全文引用配置无效');
 return value==='off'?undefined:value;
}
export function studySourceValues(value=process.env.STUDY_SOURCE_VALUES??'off'){
 if(value!=='off'&&value!=='difference-v1'&&value!=='cell-bindings-v2')throw new StudyAnswerError('configuration','invalid-source-values','来源值配置无效');
 return value==='off'?undefined:value;
}
export function studyQuantityConsistency(value=process.env.STUDY_QUANTITY_CONSISTENCY??'off'){
 if(value!=='off'&&value!=='explicit-unit-v1')throw new StudyAnswerError('configuration','invalid-quantity-consistency','数值类型核对配置无效');
 return value==='off'?undefined:value;
}
export function studySourceQuantities(value=process.env.STUDY_SOURCE_QUANTITIES??'off'){
 if(value!=='off'&&value!=='bound-value-v1')throw new StudyAnswerError('configuration','invalid-source-quantities','来源数值绑定配置无效');
 return value==='off'?undefined:value;
}
export function studySourceScope(value=process.env.STUDY_SOURCE_SCOPE??'off'){
 if(value!=='off'&&value!=='question-scope')throw new StudyAnswerError('configuration','invalid-source-scope','问题来源范围配置无效');
 return value==='off'?undefined:value;
}
export function studyScopeAnnotations(value=process.env.STUDY_SCOPE_ANNOTATIONS??'off'){
 if(value!=='off'&&value!=='literal-source-v1')throw new StudyAnswerError('configuration','invalid-scope-annotations','适用范围原文配置无效');
 return value==='off'?undefined:value;
}
export function studyCourseRouting(value=process.env.STUDY_COURSE_ROUTING??'off'){
 if(value!=='off'&&value!=='explicit-codes-v1')throw new StudyAnswerError('configuration','invalid-course-routing','课程路由配置无效');
 return value==='off'?undefined:value;
}
export function studyNativeCellObservations(value=process.env.KERNEL_NATIVE_CELL_OBSERVATIONS??'off'){
 try{return nativeCellDeclarationMode(value);}
 catch(cause){throw new StudyAnswerError('configuration','invalid-native-cell-observations','原生单元格观察配置无效',{cause});}
}
export function studyGenerationReasoning(value=process.env.STUDY_GENERATION_REASONING??'low'){
 if(value!=='low'&&value!=='medium')throw new StudyAnswerError('configuration','invalid-generation-reasoning','答案推理配置无效');
 return value==='low'?undefined:value;
}
/** Server-only and default-off; never a client request or the global model. */
export function studyGenerationModel(value=process.env.STUDY_GENERATION_MODEL){
 if(value===undefined)return undefined;
 if(value!=='gpt-6.1-sol')throw new StudyAnswerError('configuration','invalid-generation-model','生成候选模型配置无效');
 if(process.env.STUDY_ALLOW_CANDIDATE_GENERATION!=='true')assertDocumentDevelopmentRun();
 return value;
}
/** Server-only, explicit generation envelope. Selection/defaults stay unchanged. */
export function studyGenerationOutputTokens(value=process.env.STUDY_GENERATION_OUTPUT_TOKENS){
 if(value===undefined||value==='3000')return undefined;
 if(value!=='6000')throw new StudyAnswerError('configuration','invalid-generation-output','生成输出上限仅允许 3000 或 6000');
 return 6000 as const;
}
export function studyGenerationVerbosity(value=process.env.STUDY_GENERATION_VERBOSITY??'low'){
 if(value!=='low'&&value!=='medium')throw new StudyAnswerError('configuration','invalid-generation-verbosity','答案详略仅允许 low 或 medium');
 return value==='low'?undefined:value;
}
export function studySourceIdentityContext(value=process.env.STUDY_SOURCE_IDENTITY_CONTEXT??'off'){
 if(value!=='off'&&value!=='literal-course-frontpage-v1')throw new StudyAnswerError('configuration','invalid-source-identity-context','来源身份原文配置无效');
 return value==='off'?undefined:value;
}
export function studyTextContextWindows(value=process.env.STUDY_TEXT_CONTEXT_WINDOWS??'off'){
 if(value!=='off'&&value!=='producer-neighbors-v1'&&value!=='stored-page-v1')throw new StudyAnswerError('configuration','invalid-text-context-windows','原文上下文窗口配置无效');
 return value==='off'?undefined:value;
}
/** Process-only development setting; even a lower explicit limit needs isolation. */
export function studyDevelopmentDailyLimit(value=process.env.STUDY_DEVELOPMENT_DAILY_LIMIT){
 if(value===undefined)return undefined;
 assertDocumentDevelopmentRun();
 if(!/^(?:[1-9]\d{0,2}|1000)$/.test(value))
  throw new StudyAnswerError('configuration','invalid-development-daily-limit','开发每日请求上限须为 1 至 1000 的整数');
 return Number(value);
}
function citationRecorder(owner:string,question:string){
 const directory=process.env.STUDY_CITATION_TRACE_DIR;
 if(!directory||!isAbsolute(directory))throw new StudyAnswerError('configuration','citation-trace-required','引用核对需要配置私有诊断记录目录');
 const runId=randomUUID(),questionSha256=createHash('sha256').update(question).digest('hex');
 const save=async(identity:string,kind:string,value:unknown)=>{
  if(!/^[a-f0-9]{64}$/.test(identity))throw new Error('Invalid citation trace identity');
  await mkdir(directory,{recursive:true,mode:0o700});
  const file=await open(join(directory,`${runId}-${identity}.${kind}.json`),'wx',0o600);
  try{await file.writeFile(JSON.stringify({runId,owner,questionSha256,at:new Date().toISOString(),record:value})+'\n');await file.sync();}finally{await file.close();}
 };
 return {check:{mode:'selected-once' as const,beforeAttempt:async(identity:string)=>save(identity,'attempt',{requestIdentity:identity}),
  recordResponse:async(response:Readonly<import('./kernel/document-citation-audit.ts').DocumentCitationAuditResponse>)=>save(response.requestIdentity,'response',response)},
  routing:{mode:'question-scope' as const,beforeAttempt:async(identity:string)=>save(identity,'source-scope.attempt',{requestIdentity:identity}),
   recordResponse:async(response:Readonly<import('./kernel/document-answer.ts').DocumentQueryScopeResponse>)=>save(response.requestIdentity,'source-scope.response',response)},
  recordSourceValueRaw:async(receipt:Readonly<import('./kernel/document-answer.ts').DocumentSourceValueRawResponse>)=>save(receipt.providerRequestSha256,'source-values.raw-response',receipt),
  recordSourceValues:async(receipt:Readonly<import('./kernel/document-answer.ts').DocumentSourceValueDerivation>)=>save(receipt.providerRequestSha256,'source-values',receipt),
  recordSourceQuantityRaw:async(receipt:Readonly<import('./kernel/document-answer.ts').DocumentSourceQuantityRawResponse>)=>save(receipt.providerRequestSha256,'source-quantities.raw-response',receipt),
  recordSourceQuantities:async(receipt:Readonly<import('./kernel/document-answer.ts').DocumentSourceQuantityDerivation>)=>save(receipt.providerRequestSha256,'source-quantities',receipt)};
}
export function studyFailure(error:unknown){
 return error instanceof StudyAnswerError?{stage:error.stage,code:error.code}:undefined;
}
export async function answerKernelStudy(owner:string,question:string,courseId:string,history:Array<{role:string;body:string}>,requestedScope?:DocumentRoutingScope){
 const routingScope=studyRoutingScope(requestedScope),routingWitness=studyRoutingScopeWitness(routingScope);
 const nativeCellObservations=studyNativeCellObservations();
 const dailyLimit=studyDevelopmentDailyLimit();
 const evidenceSelection=studyEvidenceSelection();
 const sourceScope=studySourceScope(),citationMode=studyCitationCheck();
 const scopeAnnotations=studyScopeAnnotations();
 if(scopeAnnotations&&(studyAnswerBackend()!=='kernel'||evidenceSelection!=='select-then-answer'||citationMode!=='selected-once'||studySourceValues()||studySourceQuantities()))
  throw new StudyAnswerError('configuration','scope-annotations-require-ordinary-selection-check','适用范围原文需要普通内核证据选择和引用核对');
 const generationReasoningEffort=studyGenerationReasoning();
 const generationModel=studyGenerationModel();
 if(generationModel&&(studyAnswerBackend()!=='kernel'||evidenceSelection!=='select-then-answer'||citationMode!=='selected-once'))
  throw new StudyAnswerError('configuration','generation-model-requires-selection-check','生成候选模型需要内核证据选择和引用核对');
 const generationOutputTokens=studyGenerationOutputTokens();
 const generationVerbosity=studyGenerationVerbosity();
 const sourceIdentityContext=studySourceIdentityContext();
 if(generationOutputTokens&&(studyAnswerBackend()!=='kernel'||evidenceSelection!=='select-then-answer'||citationMode!=='selected-once'))
  throw new StudyAnswerError('configuration','generation-output-requires-selection-check','独立生成输出额度需要内核、证据选择和引用核对');
 if(generationVerbosity&&(studyAnswerBackend()!=='kernel'||evidenceSelection!=='select-then-answer'||citationMode!=='selected-once'))
  throw new StudyAnswerError('configuration','generation-verbosity-requires-selection-check','答案详略需要内核、证据选择和引用核对');
 if(sourceIdentityContext&&(studyAnswerBackend()!=='kernel'||evidenceSelection!=='select-then-answer'||citationMode!=='selected-once'))
  throw new StudyAnswerError('configuration','source-identity-requires-selection-check','来源身份原文需要内核、证据选择和引用核对');
 const textContextWindows=studyTextContextWindows();
 const sourceValueContract=studySourceValues();
 if(sourceValueContract==='cell-bindings-v2'&&nativeCellObservations!=='declared-v1')
  throw new StudyAnswerError('configuration','cell-bindings-require-native-declarations','单元格绑定需要启用原生单元格观察');
 const quantityConsistency=studyQuantityConsistency();
 const sourceQuantityContract=studySourceQuantities();
 const sourceTextCitations=studySourceTextCitations();
 if(sourceTextCitations&&(studyAnswerBackend()!=='kernel'||evidenceSelection!=='select-then-answer'||citationMode!=='selected-once'))
  throw new StudyAnswerError('configuration','source-text-citations-require-selection-check','全文引用需要内核、证据选择和引用核对');
 if(sourceQuantityContract&&(studyAnswerBackend()!=='kernel'||evidenceSelection!=='select-then-answer'||citationMode!=='selected-once'))
  throw new StudyAnswerError('configuration','source-quantities-require-selection-check','来源数值绑定需要内核、证据选择和引用核对');
 if(textContextWindows&&(studyAnswerBackend()!=='kernel'||evidenceSelection!=='select-then-answer'||citationMode!=='selected-once'))
  throw new StudyAnswerError('configuration','text-context-requires-selection-check','原文上下文窗口需要内核、证据选择和引用核对');
 if(sourceValueContract&&(studyAnswerBackend()!=='kernel'||evidenceSelection!=='select-then-answer'||studyCitationCheck()!=='selected-once'))
  throw new StudyAnswerError('configuration','source-values-require-selection-check','来源值需要内核、证据选择和原图引用核对');
 const recorder=citationMode||sourceScope?citationRecorder(owner,question):undefined,citationCheck=citationMode?recorder!.check:undefined;
 const model=serviceValue('OPENAI_MODEL')||'gpt-5-mini';
 if(!['gpt-5-mini','gpt-5.4-mini'].includes(model))throw new StudyAnswerError('configuration','unsupported-model','内核问答仅支持已配置的 mini 模型');
 const prior=history.slice(-24).map(m=>({role:m.role as 'user'|'assistant',text:m.body.slice(0,2500)}));
 const previousQuestions=prior.filter(m=>m.role==='user').slice(-2).map(m=>m.text).join('\n');
 const retrievalQuestion=previousQuestions?`${question}\nPrevious user questions (query context only):\n${previousQuestions}`:question;
 let stage:StudyFailureStage='retrieval';
 try{
  const explicitRouting=routingScope?{...routingWitness!,phase:'before-retrieval' as const,observedAt:new Date().toISOString(),
   candidateCounts:await kernel.documentRoutingCounts(owner,{...(courseId?{courseId}:{}),routingScope})}:undefined;
  const result=await kernel.answerStudyContent(owner,question,{...(courseId?{courseId}:{}),...(routingScope?{routingScope}:{}),retrievalQuestion,
   includeParents:true,includeImages:true,relatedDocuments:true,
   refineAdjacent:process.env.KERNEL_DOCUMENT_HYBRID==='true'&&process.env.KERNEL_DOCUMENT_RERANK==='true',
   semantic:process.env.KERNEL_DOCUMENT_SEMANTIC==='true',hybrid:process.env.KERNEL_DOCUMENT_HYBRID==='true',
   aiRerank:process.env.KERNEL_DOCUMENT_RERANK==='true'},
   {scope:'application',model:model as DocumentAnswerModel,reasoningEffort:'low',maxOutputTokens:3000,timeoutMs:55000,evidenceSelection,citationCheck,
    ...(sourceTextCitations?{sourceTextCitations}:{}),
    ...(scopeAnnotations?{scopeAnnotations}:{}),
    ...(quantityConsistency?{quantityConsistency}:{}),
    ...(sourceQuantityContract?{sourceQuantityContract,recordSourceQuantityRawResponse:recorder!.recordSourceQuantityRaw,recordSourceQuantityDerivation:recorder!.recordSourceQuantities}:{}),
    ...(textContextWindows?{textContextWindows}:{}),
    ...(generationReasoningEffort?{generationReasoningEffort}:{}),
    ...(generationModel?{generationModel}:{}),
    ...(generationOutputTokens?{generationOutputTokens}:{}),
    ...(generationVerbosity?{generationVerbosity}:{}),
    ...(sourceIdentityContext?{sourceIdentityContext}:{}),
    ...(sourceScope?{sourceRouting:recorder!.routing}:{}),
     ...(dailyLimit===undefined?{}:{dailyLimit}),
    ...(sourceValueContract?{sourceValueContract,recordSourceValueDerivation:recorder!.recordSourceValues,recordSourceValueRawResponse:recorder!.recordSourceValueRaw}:{}),
    conversation:prior,onStage:next=>{stage=next;}});
  const selected=result.selectedUnits,refs=new Map<string,string>();
  for(const unit of selected){const key=JSON.stringify(unit.evidence);if(!refs.has(key))refs.set(key,`S${refs.size+1}`);}
  const citations=[...refs].map(([key,ref])=>{
   const evidence=JSON.parse(key) as (typeof selected)[number]['evidence'];
   const name=result.sourceDocuments.find(document=>document.documentId===evidence.documentId)?.name??evidence.documentId;
   if(evidence.kind==='source-text'){
    const query=new URLSearchParams({evidence:'1',scope:evidence.scope,version:evidence.documentVersionId,sourceVersion:evidence.sourceVersionId,
     sourceHash:evidence.sourceHash,manifest:evidence.manifestSha256});
    return {ref,title:`${name} · 正文全文`,url:`/api/library/${encodeURIComponent(evidence.documentId)}?${query}`,parser_warnings:result.warnings,evidence};
   }
   const query=new URLSearchParams({evidence:'1',snapshot:'1',version:evidence.documentVersionId,sourceVersion:evidence.sourceVersionId,
    sourceHash:evidence.sourceHash,evidenceId:evidence.evidenceId});
   return {ref,title:`${name} · ${evidence.locator}`,url:`/api/library/${encodeURIComponent(evidence.documentId)}?${query}`,
    parser_warnings:result.warnings,evidence};
  });
  const answer=result.answer.claims.length?result.answer.claims.map((claim,i)=>{
   const claimRefs=[...new Set(selected.filter(u=>u.claimIndex===i).map(u=>refs.get(JSON.stringify(u.evidence))!))];
   return `${claim.text} ${claimRefs.map(ref=>`[${ref}]`).join('')}`;
  }).join('\n\n'):result.answer.message;
  return {answer,citations,meta:{valuable:false,takeaway:'',topic:'',assessment:'explored',evidence:'',vocabulary:[],
   citations,memories:[],web:[],webQuery:'',question,
   contextNote:`Kernel 当前证据：${result.textEvidenceCount} 条文本、${result.imageEvidenceCount} 张原图；历史对话仅用于理解追问。`,
   study:{version:STUDY_APPLICATION_VERSION,backend:'kernel',status:result.answer.status,requestedModel:generationModel??model,model:result.model,
    ...(explicitRouting?{explicitRouting}:{}),
    retrievalQuestion,settings:{reasoningEffort:generationReasoningEffort??'low',maxOutputTokens:generationOutputTokens??3000,timeoutMs:55000,
     ...(generationModel?{generationModel,evidenceSelectionModel:model}:{}),
     ...(generationOutputTokens?{generationOutputTokens,evidenceSelectionMaxOutputTokens:3000}:{}),
     ...(generationVerbosity?{generationVerbosity,evidenceSelectionVerbosity:'low'}:{}),
     ...(sourceIdentityContext?{sourceIdentityContext}:{}),
     ...(nativeCellObservations?{nativeCellObservations}:{}),
     ...(textContextWindows?{textContextWindows}:{}),
     ...(sourceTextCitations?{sourceTextCitations}:{}),
     ...(scopeAnnotations?{scopeAnnotations}:{}),
     ...(generationReasoningEffort?{evidenceSelectionReasoningEffort:'low'}:{})},
    inputFingerprint:result.inputFingerprint,providerRequestSha256:result.providerRequestSha256,
    providerResponseId:result.providerResponseId,usage:result.usage,
    contextExpansion:result.contextExpansion,
    ...('contentTagRouting' in result&&result.contentTagRouting?{contentTagRouting:result.contentTagRouting}:{}),
    ...('classificationRouting' in result&&result.classificationRouting?{classificationRouting:result.classificationRouting}:{}),
    ...('sourceIdentityContext' in result&&result.sourceIdentityContext?{sourceIdentityContext:result.sourceIdentityContext}:{}),
    ...('sourceNavigation' in result?{sourceNavigation:result.sourceNavigation}:{}),
    ...('scopeAnnotations' in result?{scopeAnnotations:result.scopeAnnotations}:{}),
    ...('sourceRouting' in result?{sourceRouting:result.sourceRouting}:{}),
    ...('evidenceSelection' in result?{evidenceSelection:result.evidenceSelection}:{}),
    ...('citationCheck' in result?{citationCheck:result.citationCheck}:{}),
    ...('sourceTextCitationCatalog' in result?{sourceTextCitationCatalog:result.sourceTextCitationCatalog}:{}),
    ...('quantityConsistency' in result?{quantityConsistency:result.quantityConsistency}:{}),
    ...('sourceQuantityContract' in result?{sourceQuantityContract:result.sourceQuantityContract}:{}),
    ...('sourceQuantityDerivation' in result&&result.sourceQuantityDerivation?{sourceQuantityDerivation:result.sourceQuantityDerivation,
     answerContract:result.sourceQuantityDerivation.method,claimOrigins:result.answer.claims.map(()=> 'program-rendered-source-quantity')}:{}),
    ...('sourceValueContract' in result?{sourceValueContract:result.sourceValueContract}:{}),
    ...('sourceValueDerivation' in result&&result.sourceValueDerivation?{sourceValueDerivation:result.sourceValueDerivation,
     answerContract:result.sourceValueDerivation.method==='source-cell-bindings-v2'?'cell-bindings-v2':'difference-v1',
     claimOrigins:result.answer.claims.map((_claim,index)=>result.sourceValueDerivation!.operations.some(op=>op.claimIndex===index)?
      (result.sourceValueDerivation!.method==='source-cell-bindings-v2'?'program-rendered-source-cell':'program-rendered-difference'):'provider-statement')}:{}),
    promptVersion:result.promptVersion,referencePolicyVersion:result.referencePolicyVersion,
    selectedUnits:result.selectedUnits,evidence:result.evidence,warnings:result.warnings,
    ...('citationReferenceNormalization' in result&&result.citationReferenceNormalization?{citationReferenceNormalization:result.citationReferenceNormalization}:{}),
    semanticVerified:false,wholeAnswerVerified:false}}};
 }catch(error){
  if(error instanceof StudyAnswerError)throw error;
  if(error instanceof DocumentContextError)throw new StudyAnswerError('structure-storage',error.code,'来源页面结构尚不可用，请先完成资料解析；本轮未发布答案',{cause:error});
  if(error instanceof DocumentModelResponseError)throw new StudyAnswerError(stage,error.code,
   error.code==='model-output-limit'?'模型在输出限制内未完成回答，本轮未发布答案':'模型响应未完成，本轮未发布答案',{cause:error});
  if(error instanceof SourceCellBindingError)throw new StudyAnswerError(error.stage,error.code,'来源单元格或完整标签路径未通过绑定验证，本轮未发布答案',{cause:error});
  if(error instanceof SourceValueHeaderError)throw new StudyAnswerError('generation',error.code,
   '表格比较缺少完整且明确的列标题关系，本轮未发布答案',{cause:error});
  if(error instanceof SourceQuantityOperationError)throw new StudyAnswerError('generation',error.code,
   '来源数值操作未通过绑定验证，本轮未发布答案',{cause:error});
  if(error instanceof DocumentCitationCheckError)throw new StudyAnswerError('citation-validation',error.code,
   error.code==='citation-support-not-established'?'回答的引用未通过核对，本轮未发布答案':'引用核对未完成，本轮未发布答案',{cause:error});
  throw new StudyAnswerError(stage,'kernel-answer-failed','内核问答未完成，请查看来源或稍后重试',{cause:error});
 }
}
