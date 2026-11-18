import {createHash} from 'node:crypto';

export const subtitleDigest=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const sha=/^[a-f0-9]{64}$/;
export type SubtitleCall = {state:'pending'|'settled'|'rejected';reservation:number;charged?:number;responseFile:string;applied?:boolean;retryAt?:string;replacementReview?:ReplacementReview};
type ReplacementReview = {schemaVersion:1;videoSha256:string;sourceHash:string;ordinal:number;originalCallSha256:string;
  originalLedgerSha256:string;originalReceiptSha256:string|null;reason:'no_saved_response'|'provider_overloaded'|'truncated_output';
  reportedUsage:{input:number;output:number}|null;firstMissing:number;batchSize:number;operator:string;reviewedAt:string};
type Ledger={sourceHash:string;model:string;promptVersion:string;calls:SubtitleCall[]};

/** Preserve the original state and reservation. A second ambiguous attempt always stops. */
export function reviewedSubtitleCall(video:string,ledger:Ledger,ordinal:number):ReplacementReview|null {
  const call=ledger.calls[ordinal-1];
  if(!call?.replacementReview)return null;
  const {replacementReview:r,...original}=call;
  if(call.state!=='pending'||call.charged!==undefined||call.applied===true||
    r.schemaVersion!==1||r.videoSha256!==video||r.sourceHash!==ledger.sourceHash||r.ordinal!==ordinal||
    !sha.test(video)||!sha.test(ledger.sourceHash)||!sha.test(r.originalLedgerSha256)||
    r.originalCallSha256!==subtitleDigest(JSON.stringify(original))||!Number.isSafeInteger(r.firstMissing)||r.firstMissing<0||
    !Number.isSafeInteger(r.batchSize)||r.batchSize<1||r.batchSize>(ledger.promptVersion==='subtitle-zh-v1'?12:1)||
    !r.operator?.trim()||!Number.isFinite(Date.parse(r.reviewedAt))||
    !['no_saved_response','provider_overloaded','truncated_output'].includes(r.reason)||
    (r.reason==='no_saved_response'?r.originalReceiptSha256!==null:!sha.test(r.originalReceiptSha256??''))||
    (r.reason==='truncated_output'?(!r.reportedUsage||![r.reportedUsage.input,r.reportedUsage.output].every(v=>Number.isSafeInteger(v)&&v>=0)):r.reportedUsage!==null))
    throw new Error('Invalid operator review for original translation call');
  return r;
}

export function subtitleReplacementBatch(ledger:Ledger,video:string,firstMissing:number):number|null {
  let review:ReplacementReview|null=null;
  for(let i=0;i<ledger.calls.length;i++){
    const call=ledger.calls[i],r=reviewedSubtitleCall(video,ledger,i+1);
    if(r){
      if(review)throw new Error('Additional replacement authorization requires separate reconciliation');
      review=r;
    }else if(call.state==='pending'||(call.state==='settled'&&!call.applied&&firstMissing>=0)){
      throw new Error('Unresolved request/result: inspect saved response/ledger before resuming; no automatic retry');
    }
  }
  if(review){
    const nextAttempt=ledger.calls.slice(review.ordinal).find(call=>!(call.state==='rejected'&&call.charged===0&&call.retryAt));
    if(!nextAttempt && firstMissing!==review.firstMissing)throw new Error('The reviewed subtitle selection changed');
    if(nextAttempt && (nextAttempt.state!=='settled'||nextAttempt.applied!==true||firstMissing===review.firstMissing))
      throw new Error('The single authorized replacement did not complete; no further replacement');
  }
  return review?.batchSize??null;
}

export function prepareSubtitleReplacement(video:string,rawLedger:string,ordinal:number,expectedDigest:string,
    firstMissing:number,operator:string,receipt:Buffer|null):Ledger {
  const ledger=JSON.parse(rawLedger) as Ledger;
  if(!sha.test(video)||!sha.test(ledger.sourceHash)||ledger.model!=='gpt-5.4-mini'||
    !['subtitle-zh-v1','subtitle-zh-v2'].includes(ledger.promptVersion)||expectedDigest!==subtitleDigest(rawLedger)||
    !Number.isSafeInteger(ordinal)||ordinal<1||ordinal!==ledger.calls.length||
    ledger.calls.some(call=>call.replacementReview)||!Number.isSafeInteger(firstMissing)||firstMissing<0||
    !operator.trim()||operator.length>160)throw new Error('Replacement does not match the reviewed source and ledger');
  const call=ledger.calls[ordinal-1];
  if(call.state!=='pending'||call.charged!==undefined||call.applied===true||!Number.isFinite(call.reservation)||call.reservation<=0||
    call.responseFile.split('/').pop()!==video+'.response-'+ordinal+'.json'||
    ledger.calls.slice(0,-1).some(c=>c.state==='pending'||(c.state==='settled'&&!c.applied)))
    throw new Error('Only the last single unresolved call can be reviewed');
  const p=receipt===null?null:JSON.parse(receipt.toString('utf8'));
  let reason:ReplacementReview['reason'],reportedUsage:ReplacementReview['reportedUsage']=null;
  if(receipt===null)reason='no_saved_response';
  else if(p?.error?.code==='server_is_overloaded'&&!p.usage)reason='provider_overloaded';
  else if(p?.status==='incomplete'&&p.incomplete_details?.reason==='max_output_tokens'&&
    ['gpt-5.4-mini','gpt-5.4-mini-2026-03-17'].includes(p.model)&&
    [p.usage?.input_tokens,p.usage?.output_tokens].every(v=>Number.isSafeInteger(v)&&v>=0)){
    reason='truncated_output';reportedUsage={input:p.usage.input_tokens,output:p.usage.output_tokens};
  }else throw new Error('Saved response requires independent reconciliation');
  call.replacementReview={schemaVersion:1,videoSha256:video,sourceHash:ledger.sourceHash,ordinal,
    originalCallSha256:subtitleDigest(JSON.stringify(call)),originalLedgerSha256:expectedDigest,
    originalReceiptSha256:receipt===null?null:subtitleDigest(receipt),reason,reportedUsage,firstMissing,
    batchSize:ledger.promptVersion==='subtitle-zh-v1'?12:1,operator,reviewedAt:new Date().toISOString()};
  subtitleReplacementBatch(ledger,video,firstMissing);
  return ledger;
}
