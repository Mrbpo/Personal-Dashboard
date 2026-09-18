import test from 'node:test';
import assert from 'node:assert/strict';
process.env.DATABASE_URL=':memory:';
process.env.OPENAI_API_KEY='test-key';
const tutor=await import('../lib/tutor.ts');
test('asking alone is not evidence of weakness or strength',()=>{
 assert.equal(tutor.evidenceAssessment('什么是浓度？','weakness','什么是浓度').assessment,'explored');
 assert.equal(tutor.evidenceAssessment('明白了','strength','明白了').assessment,'explored');
 assert.equal(tutor.evidenceAssessment('我认为答案是 2，因为 4/2=2','strength','4/2=2').assessment,'strength');
 assert.equal(tutor.evidenceAssessment('我不理解摩尔浓度','weakness','我不理解摩尔浓度').assessment,'weakness');
 assert.equal(tutor.evidenceAssessment('我不理解摩尔浓度','weakness','fabricated').assessment,'explored');
});
test('automatic course scoping recognizes explicit codes and refuses weak mixed evidence',()=>{
 const courses=[{id:'chem',code:'CHMA10H3 F 20269 All Sections',name:'General Chemistry'},{id:'stats',code:'STAB22H3',name:'Statistics'}];
 assert.equal(tutor.explicitCourseFromQuestion('CHMA10 的 lab notebook 要写什么？',courses),'chem');
 assert.equal(tutor.explicitCourseFromQuestion('统计课 Statistics 的作业',courses),'stats');
 assert.equal(tutor.dominantCourse(['chem','chem','chem','stats']),'chem');
 assert.equal(tutor.dominantCourse(['chem','stats']),'');
 assert.equal(tutor.dominantCourse(['chem']),'');
});
test('tutor persists context and attachments privately and deduplicates completed turns',async()=>{
 const original=globalThis.fetch;let calls=0,last:any;
 globalThis.fetch=async(_u,init)=>{calls++;last=JSON.parse(String(init?.body));return Response.json({output_text:JSON.stringify({answer:'A concentration explanation',valuable:true,takeaway:'Amount divided by volume',topic:'concentration',assessment:'weakness',evidence:'What is concentration?',vocabulary:[],citationRefs:[]})});};
 try{
  const id=await tutor.createTutorThread('alice','');
  await tutor.sendTutor('alice',id,'first-request-00001','What is concentration?',[tutor.validateAttachment('notes.txt',Buffer.from('local lesson'))],false);
  await tutor.sendTutor('alice',id,'first-request-00001','What is concentration?',[],false);assert.equal(calls,1);
  const state=await tutor.tutorState('alice',id);assert.equal(state.messages.length,2);assert.equal(state.archive[0].assessment,'explored');
  assert.equal('data' in state.messages[0].attachments[0],false);assert.ok(state.messages[0].attachments[0].hash);
  await assert.rejects(tutor.tutorState('bob',id));await assert.rejects(tutor.tutorAttachment('bob',state.messages[0].id,0));
  await tutor.sendTutor('alice',id,'second-request-0002','Give an example',[],false);
  assert.ok(last.input.some((m:any)=>m.role==='assistant'&&m.content[0].text==='A concentration explanation'));
  assert.ok(last.input.at(-1).content.some((p:any)=>p.type==='input_file'));
  assert.equal((await tutor.tutorState('alice',id)).messages.length,4);
 }finally{globalThis.fetch=original;}
});
