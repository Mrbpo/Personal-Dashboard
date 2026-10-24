import {test} from 'node:test';
import assert from 'node:assert/strict';
import {checkDocumentQuantityConsistency} from '../lib/kernel/document-quantity-consistency.ts';
import {DOCUMENT_ANSWER_INSUFFICIENT_MESSAGE,type GroundedDocumentAnswer} from '../lib/kernel/document-answer.ts';
const answer=(text:string):GroundedDocumentAnswer=>({status:'answered',message:'',claims:[{text,citations:[]}]});

test('explicit quantity substitution blocks the whole answer and retains the original rather than rewriting a claim',()=>{
 for(const [question,text] of [
  ['How long did training take?','The model was trained for 100 epochs per dataset.'],
  ['How quickly is this hybrid model trained?','The hybrid CNN+LSTM model was trained for 100 epochs per dataset.'],
  ['What is the percentage of human judgment agreement?','The human AUC is 0.58, or 58%.'],
  ['训练耗时多久？','每个模型训练100轮。'],
  ['人工判断的一致率是多少？','AUC为0.58。']]){
  const original=answer(text),copy=structuredClone(original),result=checkDocumentQuantityConsistency(question,original);
  assert.equal(result.status,'explicit-incompatible-quantity');assert.deepEqual(original,copy);
  assert.deepEqual(result.originalAnswer,copy);assert.equal(result.answer.status,'insufficient-evidence');
  assert.equal(result.answer.message,DOCUMENT_ANSWER_INSUFFICIENT_MESSAGE);assert.deepEqual(result.answer.claims,[]);
  assert.equal(result.sourceSupportVerified,false);assert.equal(result.wholeAnswerVerified,false);
 }
});

test('matching, mixed, implicit and unknown cases remain unassessed, including a fabricated matching label',()=>{
 for(const [question,text] of [
  ['How many epochs were used?','Each model was trained for 100 epochs.'],
  ['What is the human AUC?','The human AUC is 0.58.'],
  ['How long did training take?','Training took 2 hours for 100 epochs.'],
  ['What is the percentage of human judgment agreement?','Human judgment agreement was 58%.'],
  ['What is the percentage of human judgment agreement?','The reported number is 0.58.'],
  ['Compare AUC and human rater agreement percentages.','AUC is 0.58.'],
  ['How long did training take?','The source does not report time; it mentions 100 epochs.'],
  ['What does AUC mean?','The AUC is 0.58.']]){
  const original=answer(text),result=checkDocumentQuantityConsistency(question,original);
  assert.equal(result.status,'unassessed');assert.equal(result.answer,original);assert.equal(result.wholeAnswerVerified,false);
 }
});
