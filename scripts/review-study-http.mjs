// Offline manual-review accounting only. Never import this adapter into a provider runner.
// EXPECTED: {group:1..3,cases:[{caseKey,httpQuestionSha256,expectation}]} (50, 40/10).
// REVIEW: {caseKey,httpQuestionSha256,httpResponseSha256,answerEvidenceSha256,
// answerCorrect,coverageComplete,citationsSupported,extraAssertionsSupported,
// abstentionAppropriate?,sourceAbsenceChecked?,reviewReference?}. Booleans are human judgments.
import {readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

export const sha256=value=>createHash('sha256').update(value).digest('hex');
const dimensions=['answerCorrect','coverageComplete','citationsSupported','extraAssertionsSupported'];
const hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
export function studyAnswerEvidenceSha256(answer){
 if(!object(answer)||typeof answer.body!=='string'||!object(answer.meta))throw Error('Missing actual answer body/meta');
 return sha256(JSON.stringify({body:answer.body,meta:answer.meta}));
}
function expectedCases(expected){
 if(![1,2,3].includes(expected?.group)||!Array.isArray(expected.cases)||expected.cases.length!==50)throw Error('Expected fixed group of 50');
 expected.cases.forEach((c,i)=>{
  if(c.caseKey!==`g${expected.group}-c${String(i+1).padStart(2,'0')}`||!hex(c.httpQuestionSha256)||!['answerable','unanswerable'].includes(c.expectation))throw Error('Invalid or reordered frozen expectation');
 });
 if(expected.cases.filter(c=>c.expectation==='answerable').length!==40)throw Error('Expected frozen 40 answerable / 10 unanswerable');
 return expected.cases;
}
export function readCampaignGroup(expected,campaignRoot){
 return expectedCases(expected).map(c=>{
  const row={caseKey:c.caseKey,fileSha256:{}};
  for(const [key,name]of Object.entries({scope:'scope.json',request:'http-request.json',httpStatus:'http-status.json',terminal:'terminal.json',responseRaw:'http-response.raw.txt'})){
   let raw;try{raw=readFileSync(join(campaignRoot,'cases',c.caseKey,name));}catch(e){if(e.code==='ENOENT'){row[key]=null;row.fileSha256[name]=null;continue;}throw e;}
   row.fileSha256[name]=sha256(raw);row[key]=key==='responseRaw'?raw:JSON.parse(raw.toString('utf8'));
  }
  return row;
 });
}
export function reviewStudyHttpGroup(expected,artifacts,reviews=[]){
 const cases=expectedCases(expected),byCase=new Map(),reviewBy=new Map(),allowed=new Set(cases.map(c=>c.caseKey));
 if(!Array.isArray(artifacts)||!Array.isArray(reviews))throw Error('Artifacts/reviews must be arrays');
 for(const row of artifacts){if(!allowed.has(row?.caseKey)||byCase.has(row.caseKey))throw Error('Foreign or duplicate artifact case');byCase.set(row.caseKey,row);}
 for(const review of reviews){
  if(!allowed.has(review?.caseKey)||reviewBy.has(review.caseKey))throw Error('Foreign or duplicate independent review');
  if(!dimensions.every(k=>typeof review[k]==='boolean')||['abstentionAppropriate','sourceAbsenceChecked'].some(k=>review[k]!==undefined&&typeof review[k]!=='boolean'))throw Error('Invalid manual review dimensions');
  if(!['httpQuestionSha256','httpResponseSha256','answerEvidenceSha256'].every(k=>hex(review[k])))throw Error('Invalid review binding hash');
  reviewBy.set(review.caseKey,review);
 }
 const rows=cases.map((c,index)=>{
  const a=byCase.get(c.caseKey)??{},review=reviewBy.get(c.caseKey),scope=a.scope,request=a.request,status=a.httpStatus,terminal=a.terminal;
  const hasArtifacts=['scope','request','httpStatus','terminal','responseRaw'].some(k=>a[k]!=null),issues=[];
  if(scope&&(scope.caseKey!==c.caseKey||scope.httpQuestionSha256!==c.httpQuestionSha256))throw Error('Scope/question binding mismatch: '+c.caseKey);
  if(request&&(request.method!=='POST'||request.path!=='/api/v1/study'||typeof request.body?.question!=='string'||sha256(request.body.question)!==c.httpQuestionSha256))throw Error('HTTP question binding mismatch: '+c.caseKey);
  if(terminal&&(terminal.caseKey!==c.caseKey||status&&terminal.httpStatus!==status.status))throw Error('Terminal binding mismatch: '+c.caseKey);
  const raw=a.responseRaw??null;
  if(raw!==null&&typeof raw!=='string'&&!Buffer.isBuffer(raw))throw Error('Expected original HTTP response bytes');
  const responseSha=raw===null?null:sha256(raw);
  if(status&&(!hex(status.rawSha256)||raw!==null&&status.rawSha256!==responseSha))throw Error('HTTP raw response hash mismatch: '+c.caseKey);
  let response=null;try{if(raw!==null)response=JSON.parse(raw.toString());}catch{issues.push('invalid-response-json');}
  const answer=response?.answer,answerHash=object(answer)&&typeof answer.body==='string'&&object(answer.meta)?studyAnswerEvidenceSha256(answer):null;
  if(!scope)issues.push('missing-scope');if(!request)issues.push('missing-request');if(raw===null)issues.push('missing-response-raw');
  if(!status)issues.push('missing-http-status');if(!terminal)issues.push('missing-terminal');
  const fresh=Boolean(response?.threadId&&request?.body?.requestId&&!request.body.threadId&&answer?.id===`${response.threadId}:${request.body.requestId}:answer`&&answer.role==='assistant'&&typeof answer.body==='string'&&answer.body.trim()&&answer.meta?.question===request.body.question.trim());
  const answerStatus=answer?.meta?.study?.status??null;
  if(status?.status===200&&!fresh)issues.push('not-a-fresh-bound-assistant');
  const eligible=Boolean(!issues.length&&fresh&&status?.status===200&&terminal?.status==='answer-returned-unscored'&&['answered','conflicting-evidence','insufficient-evidence'].includes(answerStatus));
  if(review&&(!eligible||review.httpQuestionSha256!==c.httpQuestionSha256||review.httpResponseSha256!==responseSha||review.answerEvidenceSha256!==answerHash))throw Error('Review is not bound to this exact eligible HTTP answer/evidence: '+c.caseKey);
  const judgments=Object.fromEntries(dimensions.map(k=>[k,review?.[k]??null]));
  const appropriate=answerStatus!=='insufficient-evidence'||c.expectation==='unanswerable'&&review?.abstentionAppropriate===true&&review?.sourceAbsenceChecked===true;
  return {caseKey:c.caseKey,index,expectation:c.expectation,httpQuestionSha256:c.httpQuestionSha256,httpResponseSha256:responseSha,answerEvidenceSha256:answerHash,
   artifactFileSha256:a.fileSha256??null,question:request?.body?.question??null,answer:answerHash?{body:answer.body,meta:answer.meta}:null,
   executionStatus:!hasArtifacts?'unrun':raw===null?'missing-raw':terminal?.status??'unclosed',httpStatus:status?.status??null,
   productFailure:Boolean(raw!==null&&status?.status!==200&&terminal?.status==='known-product-failure'),failure:response?.failure??terminal?.failure??null,
   eligible,issues,answerStatus,independentReviewed:Boolean(review),...judgments,
   abstentionAppropriate:answerStatus==='insufficient-evidence'?review?.abstentionAppropriate??null:null,
   sourceAbsenceChecked:answerStatus==='insufficient-evidence'?review?.sourceAbsenceChecked??null:null,
   strictPass:Boolean(eligible&&review&&appropriate&&dimensions.every(k=>judgments[k]===true)),reviewReference:review?.reviewReference??null};
 });
 const count=fn=>rows.filter(fn).length,answerable=rows.filter(r=>r.expectation==='answerable'),unanswerable=rows.filter(r=>r.expectation==='unanswerable');
 return {method:'manual-four-dimension-http-review-v1',group:expected.group,expectedCanonicalSha256:sha256(JSON.stringify(expected)),
  totals:{denominator:50,strictPass:count(r=>r.strictPass),notStrictPass:count(r=>!r.strictPass),eligibleAnswers:count(r=>r.eligible),
   unrun:count(r=>r.executionStatus==='unrun'),missingRaw:count(r=>r.executionStatus==='missing-raw'),productFailures:count(r=>r.productFailure),
   unavailable:count(r=>!r.eligible),independentlyReviewed:reviews.length,unreviewed:50-reviews.length,unreviewedAnswers:count(r=>r.eligible&&!r.independentReviewed)},
  answerable:{denominator:40,strictPass:answerable.filter(r=>r.strictPass).length,answerCorrect:answerable.filter(r=>r.eligible&&r.answerStatus!=='insufficient-evidence'&&r.answerCorrect===true).length,
   coverageComplete:answerable.filter(r=>r.eligible&&r.answerStatus!=='insufficient-evidence'&&r.coverageComplete===true).length,unavailable:answerable.filter(r=>!r.eligible).length,
   falseRefusals:answerable.filter(r=>r.eligible&&r.answerStatus==='insufficient-evidence').length},
  unanswerable:{denominator:10,strictPass:unanswerable.filter(r=>r.strictPass).length,correctRefusals:unanswerable.filter(r=>r.strictPass&&r.answerStatus==='insufficient-evidence').length},
  unmeasured:{officialAnswerF1:null,officialEvidenceF1:null,pdfFidelityPercent:null,structurePercent:null,evidenceRecall:null,claimCitationPrecision:null,
   reason:'No official annotation mapping, element/claim denominators or independent per-claim review supplied to this adapter.'},
  wholeV1Pass:null,automaticSemanticPass:false,rows,
  note:'Fixed50 positions retained. Product local judgments are not manual reviews. Four human dimensions plus bound actual output are required; insufficient-evidence additionally requires frozen unanswerable and two independent abstention checks. No best-answer selection or whole-V1 verdict.'};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [expectedPath,campaignRoot,reviewsPath,outputPath]=process.argv.slice(2);
 if(!expectedPath||!campaignRoot||process.argv.length>6)throw Error('Usage: node review-study-http.mjs EXPECTED.json CAMPAIGN_ROOT [REVIEWS.json] [OUTPUT.json]');
 const expectedRaw=readFileSync(expectedPath),expected=JSON.parse(expectedRaw),reviewRaw=reviewsPath?readFileSync(reviewsPath):null;
 const report=reviewStudyHttpGroup(expected,readCampaignGroup(expected,campaignRoot),reviewRaw?JSON.parse(reviewRaw):[]);
 report.expectedFileSha256=sha256(expectedRaw);report.reviewFileSha256=reviewRaw?sha256(reviewRaw):null;
 const output=outputPath??join(campaignRoot,`group-${expected.group}-independent-review.LOCAL-ONLY.json`);
 writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify({output,sha256:sha256(readFileSync(output)),totals:report.totals,wholeV1Pass:null}));
}
