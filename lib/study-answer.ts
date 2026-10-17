import {kernel} from './kernel/service.ts';
import {serviceValue} from './service-vault.ts';
import type {DocumentAnswerModel} from './kernel/document-answer.ts';

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
export function studyFailure(error:unknown){
 return error instanceof StudyAnswerError?{stage:error.stage,code:error.code}:undefined;
}
export async function answerKernelStudy(owner:string,question:string,courseId:string,history:Array<{role:string;body:string}>){
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
   {scope:'application',model:model as DocumentAnswerModel,reasoningEffort:'low',maxOutputTokens:3000,timeoutMs:55000,
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
    promptVersion:result.promptVersion,referencePolicyVersion:result.referencePolicyVersion,
    selectedUnits:result.selectedUnits,evidence:result.evidence,warnings:result.warnings,
    semanticVerified:false,wholeAnswerVerified:false}}};
 }catch(error){
  if(error instanceof StudyAnswerError)throw error;
  throw new StudyAnswerError(stage,'kernel-answer-failed','内核问答未完成，请查看来源或稍后重试',{cause:error});
 }
}
