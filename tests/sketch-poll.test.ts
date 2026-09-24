import test from 'node:test';
import assert from 'node:assert/strict';
import { isSketchEditable, planSketchPoll, shouldRetrySketchPageSave } from '../lib/sketch-poll.ts';

test('same-book archive failure re-enables an editable snapshot without losing local art',()=>{
  const localPage={page_no:1,revision:3,image_hash:'local'};
  const current={book:{id:'book',status:'archiving'},pages:[localPage]};
  const recovered={book:{id:'book',status:'active'},pages:[{page_no:1,revision:2,image_hash:'old'}]};
  const plan=planSketchPoll(current,recovered,true);
  assert.equal(plan.kind,'apply');
  if(plan.kind!=='apply')return;
  assert.equal(plan.snapshot.book.status,'active');
  assert.equal(isSketchEditable(plan.snapshot.book.status),true);
  assert.equal(shouldRetrySketchPageSave(plan.snapshot.book.status,true,false),true);
  assert.equal(plan.snapshot.pages[0],localPage);
});

test('same-book archiving disables edits, and unfinished art blocks switching books',()=>{
  const current={book:{id:'book',status:'active'},pages:[{page_no:1}]};
  const archiving=planSketchPoll(current,{book:{id:'book',status:'archiving'},pages:[]},true);
  assert.equal(archiving.kind,'apply');
  if(archiving.kind==='apply')assert.equal(isSketchEditable(archiving.snapshot.book.status),false);
  assert.equal(shouldRetrySketchPageSave('archiving',true,false),false);
  assert.equal(shouldRetrySketchPageSave('active',true,true),false);
  assert.deepEqual(planSketchPoll(current,{book:{id:'new',status:'active'},pages:[]},true),{kind:'inspectCurrent'});
  assert.equal(planSketchPoll(current,{book:{id:'new',status:'active'},pages:[]},false).kind,'switch');
});
