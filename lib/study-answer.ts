import {kernel} from './kernel/service.ts';
import {serviceValue} from './service-vault.ts';
import type {DocumentAnswerModel} from './kernel/document-answer.ts';
import {DocumentCitationCheckError} from './kernel/document-citation-audit.ts';
import {SourceValueHeaderError} from './kernel/document-source-values.ts';
import {assertDocumentDevelopmentRun} from './kernel/document-rerank.ts';
import {randomUUID,createHash} from 'node:crypto';
import {mkdir,open} from 'node:fs/promises';
import {isAbsolute,join} from 'node:path';

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
export function studyEvidenceSelection(value=process.env.STUDY_EVIDENCE_SELECTION??'single-pass'){
 if(value!=='single-pass'&&value!=='select-then-answer')throw new StudyAnswerError('configuration','invalid-evidence-selection','证据选择配置无效');
 return value==='single-pass'?undefined:value;
}
export function studyCitationCheck(value=process.env.STUDY_CITATION_CHECK??'off'){
 if(value!=='off'&&value!=='selected-once')throw new StudyAnswerError('configuration','invalid-citation-check','引用核对配置无效');
 return value==='off'?undefined:value;
}
export function studySourceValues(value=process.env.STUDY_SOURCE_VALUES??'off'){
 if(value!=='off'&&value!=='difference-v1')throw new StudyAnswerError('configuration','invalid-source-values','来源值配置无效');
 return value==='off'?undefined:value;
}
export function studySourceScope(value=process.env.STUDY_SOURCE_SCOPE??'off'){
 if(value!=='off'&&value!=='question-scope')throw new StudyAnswerError('configuration','invalid-source-scope','问题来源范围配置无效');
 return value==='off'?undefined:value;
}
export function studyGenerationReasoning(value=process.env.STUDY_GENERATION_REASONING??'low'){
 if(value!=='low'&&value!=='medium')throw new StudyAnswerError('configuration','invalid-generation-reasoning','答案推理配置无效');
 return value==='low'?undefined:value;
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
  recordSourceValues:async(receipt:Readonly<import('./kernel/document-answer.ts').DocumentSourceValueDerivation>)=>save(receipt.providerRequestSha256,'source-values',receipt)};
}
export function studyFailure(error:unknown){
 return error instanceof StudyAnswerError?{stage:error.stage,code:error.code}:undefined;
}
export async function answerKernelStudy(owner:string,question:string,courseId:string,history:Array<{role:string;body:string}>){
 const dailyLimit=studyDevelopmentDailyLimit();
 const evidenceSelection=studyEvidenceSelection();
 const sourceScope=studySourceScope(),citationMode=studyCitationCheck();
 const generationReasoningEffort=studyGenerationReasoning();
 const textContextWindows=studyTextContextWindows();
 const sourceValueContract=studySourceValues();
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
  const result=await kernel.answerStudyContent(owner,question,{...(courseId?{courseId}:{}),retrievalQuestion,
   includeParents:true,includeImages:true,relatedDocuments:true,
   refineAdjacent:process.env.KERNEL_DOCUMENT_HYBRID==='true'&&process.env.KERNEL_DOCUMENT_RERANK==='true',
   semantic:process.env.KERNEL_DOCUMENT_SEMANTIC==='true',hybrid:process.env.KERNEL_DOCUMENT_HYBRID==='true',
   aiRerank:process.env.KERNEL_DOCUMENT_RERANK==='true'},
   {scope:'application',model:model as DocumentAnswerModel,reasoningEffort:'low',maxOutputTokens:3000,timeoutMs:55000,evidenceSelection,citationCheck,
    ...(textContextWindows?{textContextWindows}:{}),
    ...(generationReasoningEffort?{generationReasoningEffort}:{}),
    ...(sourceScope?{sourceRouting:recorder!.routing}:{}),
     ...(dailyLimit===undefined?{}:{dailyLimit}),
    ...(sourceValueContract?{sourceValueContract,recordSourceValueDerivation:recorder!.recordSourceValues,recordSourceValueRawResponse:recorder!.recordSourceValueRaw}:{}),
    conversation:prior,onStage:next=>{stage=next;}});
  const selected=result.selectedUnits,refs=new Map<string,string>();
  for(const unit of selected){const key=JSON.stringify(unit.evidence);if(!refs.has(key))refs.set(key,`S${refs.size+1}`);}
  const citations=[...refs].map(([key,ref])=>{
   const evidence=JSON.parse(key) as (typeof selected)[number]['evidence'];
   const name=result.sourceDocuments.find(document=>document.documentId===evidence.documentId)?.name??evidence.documentId;
   const query=new URLSearchParams({evidence:'1',version:evidence.documentVersionId,sourceVersion:evidence.sourceVersionId,
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
   study:{version:STUDY_APPLICATION_VERSION,backend:'kernel',status:result.answer.status,requestedModel:model,model:result.model,
    retrievalQuestion,settings:{reasoningEffort:generationReasoningEffort??'low',maxOutputTokens:3000,timeoutMs:55000,
     ...(textContextWindows?{textContextWindows}:{}),
     ...(generationReasoningEffort?{evidenceSelectionReasoningEffort:'low'}:{})},
    inputFingerprint:result.inputFingerprint,providerRequestSha256:result.providerRequestSha256,
    providerResponseId:result.providerResponseId,usage:result.usage,
    contextExpansion:result.contextExpansion,
    ...('sourceRouting' in result?{sourceRouting:result.sourceRouting}:{}),
    ...('evidenceSelection' in result?{evidenceSelection:result.evidenceSelection}:{}),
    ...('citationCheck' in result?{citationCheck:result.citationCheck}:{}),
    ...('sourceValueContract' in result?{sourceValueContract:result.sourceValueContract}:{}),
    ...('sourceValueDerivation' in result&&result.sourceValueDerivation?{sourceValueDerivation:result.sourceValueDerivation,answerContract:'difference-v1',
     claimOrigins:result.answer.claims.map((_claim,index)=>result.sourceValueDerivation!.operations.some(op=>op.claimIndex===index)?
      'program-rendered-difference':'provider-statement')}:{}),
    promptVersion:result.promptVersion,referencePolicyVersion:result.referencePolicyVersion,
    selectedUnits:result.selectedUnits,evidence:result.evidence,warnings:result.warnings,
    semanticVerified:false,wholeAnswerVerified:false}}};
 }catch(error){
  if(error instanceof StudyAnswerError)throw error;
  if(error instanceof SourceValueHeaderError)throw new StudyAnswerError('generation',error.code,
   '表格比较缺少完整且明确的列标题关系，本轮未发布答案',{cause:error});
  if(error instanceof DocumentCitationCheckError)throw new StudyAnswerError('citation-validation',error.code,
   error.code==='citation-support-not-established'?'回答的引用未通过核对，本轮未发布答案':'引用核对未完成，本轮未发布答案',{cause:error});
  throw new StudyAnswerError(stage,'kernel-answer-failed','内核问答未完成，请查看来源或稍后重试',{cause:error});
 }
}
