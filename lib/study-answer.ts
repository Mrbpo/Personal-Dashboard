import {kernel} from './kernel/service.ts';
import {serviceValue} from './service-vault.ts';
import type {DocumentAnswerModel} from './kernel/document-answer.ts';
import {DocumentCitationCheckError} from './kernel/document-citation-audit.ts';
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
 return {mode:'selected-once' as const,beforeAttempt:async(identity:string)=>save(identity,'attempt',{requestIdentity:identity}),
  recordResponse:async(response:Readonly<import('./kernel/document-citation-audit.ts').DocumentCitationAuditResponse>)=>save(response.requestIdentity,'response',response)};
}
export function studyFailure(error:unknown){
 return error instanceof StudyAnswerError?{stage:error.stage,code:error.code}:undefined;
}
export async function answerKernelStudy(owner:string,question:string,courseId:string,history:Array<{role:string;body:string}>){
 const evidenceSelection=studyEvidenceSelection();
 const citationCheck=studyCitationCheck()?citationRecorder(owner,question):undefined;
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
    retrievalQuestion,settings:{reasoningEffort:'low',maxOutputTokens:3000,timeoutMs:55000},
    inputFingerprint:result.inputFingerprint,providerRequestSha256:result.providerRequestSha256,
    providerResponseId:result.providerResponseId,usage:result.usage,
    contextExpansion:result.contextExpansion,
    ...('evidenceSelection' in result?{evidenceSelection:result.evidenceSelection}:{}),
    ...('sourceScopedGeneration' in result?{sourceScopedGeneration:result.sourceScopedGeneration}:{}),
    ...('citationCheck' in result?{citationCheck:result.citationCheck}:{}),
    promptVersion:result.promptVersion,referencePolicyVersion:result.referencePolicyVersion,
    selectedUnits:result.selectedUnits,evidence:result.evidence,warnings:result.warnings,
    semanticVerified:false,wholeAnswerVerified:false}}};
 }catch(error){
  if(error instanceof StudyAnswerError)throw error;
  if(error instanceof DocumentCitationCheckError)throw new StudyAnswerError('citation-validation',error.code,
   error.code==='citation-support-not-established'?'回答的引用未通过核对，本轮未发布答案':'引用核对未完成，本轮未发布答案',{cause:error});
  throw new StudyAnswerError(stage,'kernel-answer-failed','内核问答未完成，请查看来源或稍后重试',{cause:error});
 }
}
