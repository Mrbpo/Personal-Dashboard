import test from 'node:test';
import assert from 'node:assert/strict';
process.env.DATABASE_URL=':memory:';
const feedback=await import('../lib/ai-feedback.ts');

test('mini AI feedback is owner-scoped and updates without duplicating the content record',async()=>{
 await feedback.saveAiFeedback('alice',{sourceType:'tutor',sourceId:'message-1',rating:-1,reason:'遗漏了原文日期',metadata:{model:'test'}});
 await feedback.saveAiFeedback('alice',{sourceType:'tutor',sourceId:'message-1',rating:1,reason:''});
 await feedback.saveAiFeedback('bob',{sourceType:'tutor',sourceId:'message-1',rating:-1,reason:'不同用户'});
 const alice=await feedback.aiFeedbackSummary('alice'),bob=await feedback.aiFeedbackSummary('bob');assert.equal(alice.recent.length,1);assert.equal(alice.recent[0].rating,1);assert.equal(bob.recent.length,1);assert.equal(bob.recent[0].rating,-1);
});

test('mini AI feedback rejects unknown sources and invalid ratings',async()=>{
 await assert.rejects(feedback.saveAiFeedback('alice',{sourceType:'unknown',sourceId:'x',rating:1}),/无效/);
 await assert.rejects(feedback.saveAiFeedback('alice',{sourceType:'mail',sourceId:'x',rating:0}),/无效/);
});
