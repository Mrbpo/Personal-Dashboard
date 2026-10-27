import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {reviewStudyHttpGroup,readCampaignGroup,studyAnswerEvidenceSha256,sha256} from '../scripts/review-study-http.mjs';

// Synthetic placeholders only: no official question, annotation, source or provider is used.
const expected=()=>({group:1,cases:Array.from({length:50},(_,i)=>({caseKey:`g1-c${String(i+1).padStart(2,'0')}`,
 httpQuestionSha256:sha256(`Synthetic question ${i+1}`),expectation:i<40?'answerable':'unanswerable'}))});
function artifact(index=0,answerStatus='answered'){
 const c=expected().cases[index],question=`Synthetic question ${index+1}`,requestId=`request-${index}`;
 const answer={id:`thread-${index}:${requestId}:answer`,role:'assistant',body:'Synthetic answer.',meta:{question,
  citations:[{ref:'S1',evidence:{sourceHash:'synthetic-source'}}],study:{status:answerStatus,selectedUnits:[{refId:'q:synthetic'}],
   citationCheck:{supported:true,wholeAnswerVerified:true}}}};
 const responseRaw=JSON.stringify({threadId:`thread-${index}`,answer});
 return {caseKey:c.caseKey,scope:{caseKey:c.caseKey,httpQuestionSha256:c.httpQuestionSha256},
  request:{method:'POST',path:'/api/v1/study',body:{question,requestId}},responseRaw,
  httpStatus:{status:200,rawSha256:sha256(responseRaw)},terminal:{caseKey:c.caseKey,httpStatus:200,status:'answer-returned-unscored'}};
}
function review(a:ReturnType<typeof artifact>){
 return {caseKey:a.caseKey,httpQuestionSha256:a.scope.httpQuestionSha256,httpResponseSha256:sha256(a.responseRaw),
  answerEvidenceSha256:studyAnswerEvidenceSha256(JSON.parse(a.responseRaw).answer),answerCorrect:true,coverageComplete:true,
  citationsSupported:true,extraAssertionsSupported:true};
}
test('fixed50 denominator retains missing/product/unrun and explicit unmeasured metrics; file loader stays offline',()=>{
 const directory=mkdtempSync(join(tmpdir(),'study-http-review-'));
 try{
  const a=artifact(),caseDir=join(directory,'cases',a.caseKey);mkdirSync(caseDir,{recursive:true});
  writeFileSync(join(caseDir,'scope.json'),JSON.stringify(a.scope));writeFileSync(join(caseDir,'http-request.json'),JSON.stringify(a.request));
  const rows=readCampaignGroup(expected(),directory),report=reviewStudyHttpGroup(expected(),rows);
  assert.equal(report.rows.length,50);assert.equal(report.totals.denominator,50);assert.equal(report.totals.unrun,49);
  assert.equal(report.totals.missingRaw,1);assert.equal(report.totals.strictPass,0);assert.equal(report.totals.unreviewed,50);
  assert.equal(report.answerable.denominator,40);assert.equal(report.unanswerable.denominator,10);
  assert.equal(report.wholeV1Pass,null);for(const [key,value]of Object.entries(report.unmeasured))if(key!=='reason')assert.equal(value,null);
  const failed={...a,responseRaw:JSON.stringify({failure:{stage:'retrieval',code:'synthetic-failure'}})};
  failed.httpStatus={status:400,rawSha256:sha256(failed.responseRaw)};failed.terminal={caseKey:a.caseKey,httpStatus:400,status:'known-product-failure'};
  const product=reviewStudyHttpGroup(expected(),[failed]);assert.equal(product.totals.productFailures,1);assert.equal(product.totals.strictPass,0);
 }finally{rmSync(directory,{recursive:true,force:true});}
});
test('product supported never passes without four human dimensions and a fresh bound assistant',()=>{
 const a=artifact();assert.equal(reviewStudyHttpGroup(expected(),[a]).totals.strictPass,0);
 const good=reviewStudyHttpGroup(expected(),[a],[review(a)]);assert.equal(good.totals.strictPass,1);assert.equal(good.totals.unreviewed,49);
 assert.deepEqual(good.rows[0].answer,((({body,meta})=>({body,meta}))(JSON.parse(a.responseRaw).answer)));
 const stale={...a,responseRaw:JSON.stringify({...JSON.parse(a.responseRaw),answer:{...JSON.parse(a.responseRaw).answer,id:'old-assistant'}})};
 stale.httpStatus={status:200,rawSha256:sha256(stale.responseRaw)};
 assert.equal(reviewStudyHttpGroup(expected(),[stale]).totals.strictPass,0);
 assert.throws(()=>reviewStudyHttpGroup(expected(),[stale],[review(stale)]),/exact eligible/);
});
test('wrong response/question/evidence hashes, duplicate/foreign inputs and illegal judgments fail closed',()=>{
 const a=artifact(),r=review(a),bad='f'.repeat(64);
 assert.throws(()=>reviewStudyHttpGroup(expected(),[{...a,httpStatus:{...a.httpStatus,rawSha256:bad}}]),/raw response hash/);
 for(const key of ['httpQuestionSha256','httpResponseSha256','answerEvidenceSha256'])assert.throws(()=>reviewStudyHttpGroup(expected(),[a],[{...r,[key]:bad}]),/exact eligible/);
 assert.throws(()=>reviewStudyHttpGroup(expected(),[a],[r,r]),/duplicate independent/);
 assert.throws(()=>reviewStudyHttpGroup(expected(),[a],[{...r,caseKey:'g2-c01'}]),/Foreign/);
 assert.throws(()=>reviewStudyHttpGroup(expected(),[a,a]),/duplicate artifact/);
 assert.throws(()=>reviewStudyHttpGroup(expected(),[{...a,caseKey:'g2-c01'}]),/Foreign/);
 assert.throws(()=>reviewStudyHttpGroup(expected(),[a],[{...r,answerCorrect:'true'}]),/dimensions/);
 assert.throws(()=>reviewStudyHttpGroup(expected(),[a],[{...r,coverageComplete:undefined}]),/dimensions/);
 const changed=JSON.parse(a.responseRaw);changed.answer.meta.study.selectedUnits=[{refId:'q:different'}];
 const swapped={...a,responseRaw:JSON.stringify(changed)};swapped.httpStatus={status:200,rawSha256:sha256(swapped.responseRaw)};
 assert.throws(()=>reviewStudyHttpGroup(expected(),[swapped],[r]),/exact eligible/);
 const missing={...a,responseRaw:null};assert.equal(reviewStudyHttpGroup(expected(),[missing]).totals.strictPass,0);
});
test('refusals keep frozen40/10 expectations and all four human dimensions plus source-absence checks',()=>{
 const answerable=artifact(0,'insufficient-evidence'),unanswerable=artifact(40,'insufficient-evidence');
 const yes={abstentionAppropriate:true,sourceAbsenceChecked:true};
 const falseRefusal=reviewStudyHttpGroup(expected(),[answerable],[{...review(answerable),...yes}]);
 assert.equal(falseRefusal.totals.strictPass,0);assert.equal(falseRefusal.answerable.falseRefusals,1);
 assert.equal(falseRefusal.answerable.answerCorrect,0);assert.equal(falseRefusal.answerable.coverageComplete,0);
 assert.equal(falseRefusal.rows[0].answerCorrect,true);assert.equal(falseRefusal.rows[0].coverageComplete,true);
 assert.equal(reviewStudyHttpGroup(expected(),[unanswerable],[review(unanswerable)]).totals.strictPass,0);
 const correct=reviewStudyHttpGroup(expected(),[unanswerable],[{...review(unanswerable),...yes}]);
 assert.equal(correct.totals.strictPass,1);assert.equal(correct.unanswerable.correctRefusals,1);
 assert.equal(reviewStudyHttpGroup(expected(),[unanswerable],[{...review(unanswerable),...yes,coverageComplete:false}]).totals.strictPass,0);
 const conflict=artifact(1,'conflicting-evidence');assert.equal(reviewStudyHttpGroup(expected(),[conflict],[review(conflict)]).totals.strictPass,1);
});
