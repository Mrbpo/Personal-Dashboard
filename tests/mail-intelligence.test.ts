import test from 'node:test';
import assert from 'node:assert/strict';
/* eslint-disable @typescript-eslint/no-explicit-any */
process.env.DATABASE_URL=':memory:';
process.env.AI_BUDGET_TEST_BYPASS='true';
process.env.OPENAI_API_KEY='test-key';
process.env.OPENAI_MODEL='gpt-5-mini';
const intelligence=await import('../lib/mail-intelligence.ts');
const {database:db}=await import('../lib/database.ts');
const {saveIntegrationConnection}=await import('../lib/repository.ts');
const {seal}=await import('../lib/service-vault.ts');

async function seed(){
 await saveIntegrationConnection('gmail',seal({refresh:'test'}),{owner:'alice',email:'alice@example.invalid'});
 await db.prepare(`INSERT OR IGNORE INTO mail_messages (id,account,thread_id,subject,sender,body,received_at,category,attachments_json,hash) VALUES (?,?,?,?,?,?,?,?,?,?)`).bind('mail-1','alice@example.invalid','thread-1','BIOA01 Lab update','Professor <prof@example.edu>','Please submit the revised lab protocol by Friday.','2026-09-21T12:00:00Z','学习','[]','hash-1').run();
 await intelligence.recordMailIngest('alice@example.invalid',{id:'mail-1',sender:'Professor <prof@example.edu>',subject:'BIOA01 Lab update',receivedAt:'2026-09-21T12:00:00Z'},{category:'学习',actionRequired:true,deadlineText:'by Friday',reason:'课程邮件',priority:4},true);
}

test('ingestion builds a local versioned intelligence record and sender profile without rescanning history',async()=>{
 await seed();await intelligence.recordMailIngest('alice@example.invalid',{id:'mail-1',sender:'Professor <prof@example.edu>',subject:'BIOA01 Lab update',receivedAt:'2026-09-21T12:00:00Z'},{category:'学习',actionRequired:true,deadlineText:'by Friday',reason:'课程邮件',priority:4},false);
 const record=await intelligence.getMailIntelligence('alice','mail-1');assert.ok(record);assert.equal(record.category,'学习');assert.equal(record.model,'local-rules');assert.equal(record.analysisVersion,intelligence.MAIL_ANALYSIS_VERSION);
 const profile=await db.prepare('SELECT * FROM mail_sender_profiles WHERE account=?').bind('alice@example.invalid').first<any>();assert.equal(profile.message_count,1);assert.equal(profile.action_count,1);
});

test('feedback preserves the prediction, updates the effective value and becomes retrievable context',async()=>{
 await seed();await intelligence.recordMailFeedback('alice','mail-1','category','服务','教授地址应归入服务');
 const feedback=await db.prepare('SELECT * FROM mail_feedback WHERE email_id=?').bind('mail-1').first<any>();assert.equal(JSON.parse(feedback.predicted_json),'学习');assert.equal(JSON.parse(feedback.corrected_json),'服务');
 const message=await db.prepare('SELECT category,category_source FROM mail_messages WHERE id=?').bind('mail-1').first<any>();assert.deepEqual(message,{category:'服务',category_source:'manual'});
 const context=await intelligence.buildMailContext('alice','mail-1');assert.equal(context.feedback.length,1);assert.equal(context.feedback[0].corrected,'服务');
});

test('malformed model output is contained and recorded as a retryable processing failure',async()=>{
 await seed();const original=globalThis.fetch;globalThis.fetch=async()=>Response.json({output_text:'not json'});
 try{await assert.rejects(intelligence.analyzeMailIntelligence('alice','mail-1',true),/格式无效/);const state=await db.prepare('SELECT status,error FROM mail_processing WHERE email_id=?').bind('mail-1').first<any>();assert.equal(state.status,'failed');assert.match(state.error,/格式无效/);}finally{globalThis.fetch=original;}
});

test('structured analysis stores version, evidence, hybrid importance and entity memory',async()=>{
 await seed();const original=globalThis.fetch;globalThis.fetch=async(url)=>String(url).endsWith('/embeddings')?Response.json({data:[{index:0,embedding:Array(768).fill(.01)}]}):Response.json({output_text:JSON.stringify({oneLineSummary:'BIOA01 实验材料已更新，周五前提交。',detailedSummary:'教授要求使用修订后的实验协议，并在周五前提交。',category:'学习',subcategory:'实验更新',importanceScore:4,urgencyScore:4,confidence:.92,requiresAction:true,actionItems:[{title:'提交修订实验协议',description:'检查后提交',dueAt:null,confidence:.8,evidence:'submit the revised lab protocol by Friday'}],deadlines:[{at:null,text:'周五前',confidence:.7,evidence:'by Friday'}],events:[],people:['Professor'],organizations:[],courses:['BIOA01'],projects:[],topics:['Lab'],keywords:['protocol'],referencedDocuments:[],referencedUrls:[],whyImportant:['要求提交实验材料'],suggestions:['核对原邮件中的具体日期'],needsReply:false})});
 try{const result=await intelligence.analyzeMailIntelligence('alice','mail-1',true);assert.ok(result);assert.equal(result.category,'服务','人工纠正不得被重新分析覆盖');assert.ok(result.importanceScore>=4);const entity=await db.prepare("SELECT canonical_name FROM mail_entities WHERE entity_type='course'").first<any>();assert.equal(entity.canonical_name,'BIOA01');const vector=await db.prepare('SELECT input_hash FROM mail_embeddings WHERE email_id=?').bind('mail-1').first();assert.ok(vector);}finally{globalThis.fetch=original;}
});

test('night maintenance queues only bounded, non-junk local intelligence work',async()=>{
 await seed();await db.prepare(`INSERT OR IGNORE INTO mail_messages (id,account,thread_id,subject,sender,body,received_at,category,attachments_json,hash) VALUES (?,?,?,?,?,?,?,?,?,?)`).bind('mail-night','alice@example.invalid','thread-night','Weekly course reminder','notice@example.edu','Review the lecture notes.','2026-09-21T13:00:00Z','学习','[]','hash-night').run();
 await intelligence.recordMailIngest('alice@example.invalid',{id:'mail-night',sender:'notice@example.edu',subject:'Weekly course reminder',receivedAt:'2026-09-21T13:00:00Z'},{category:'学习',actionRequired:false,deadlineText:'',reason:'课程邮件',priority:2},true);
 const result=await intelligence.queueNightMailMaintenance('alice','2026-09-21');assert.ok(result.queued>=1);const queued=await db.prepare("SELECT kind,status FROM background_jobs WHERE id LIKE 'mail-night:2026-09-21:%' LIMIT 1").first<{kind:string;status:string}>();assert.deepEqual(queued,{kind:'mail-intelligence',status:'queued'});
});
