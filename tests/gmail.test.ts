import test from 'node:test';
import assert from 'node:assert/strict';
process.env.DATABASE_URL=':memory:';
process.env.GMAIL_CLIENT_ID='test-client';process.env.GMAIL_CLIENT_SECRET='test-secret';process.env.GMAIL_REDIRECT_URI='http://localhost:3000/api/mail/callback';
const gmail=await import('../lib/gmail.ts');
const {database:db}=await import('../lib/database.ts');
const {saveIntegrationConnection}=await import('../lib/repository.ts');
const {seal}=await import('../lib/service-vault.ts');
test('Gmail MIME parsing prefers text and does not render tracking images',()=>{
 const p=gmail.decodeMail({parts:[{mimeType:'text/html',body:{data:Buffer.from('<p>Hello</p><img src="https://tracking.test/x">').toString('base64url')}},{mimeType:'text/plain',body:{data:Buffer.from('Plain version').toString('base64url')}},{filename:'lab.pdf',mimeType:'application/pdf',body:{attachmentId:'a',size:30}}]});
 assert.equal(p.body,'Plain version');assert.equal(p.attachments.length,1);assert.equal(p.attachments[0].id,'a');
});
test('mail intelligence separates learning, service and junk while exposing nearby verification codes',()=>{
 const learning=gmail.mailSignals('CHMA10 Lab assignment due Friday','Quercus <no-reply@utoronto.ca>','Please submit your lab report before Friday');
 assert.equal(learning.category,'学习');assert.equal(learning.actionRequired,true);assert.match(learning.deadlineText,/due/i);
 const service=gmail.mailSignals('Your verification code is 482913','Accounts','Use verification code 482913 to confirm sign-in');
 assert.equal(service.category,'服务');assert.deepEqual(service.verificationCodes,['482913']);
 const junk=gmail.mailSignals('Claim your prize now','promo@example.test','Guaranteed income and crypto giveaway');
 assert.equal(junk.category,'垃圾');assert.equal(junk.actionRequired,false);
});
test('Gmail initial pagination, incremental cursor expiry and revoked auth keep archives and make no mail mutations',async()=>{
 await saveIntegrationConnection('gmail',seal({refresh:'test-refresh'}),{owner:'alice',email:'example@test.invalid'});
 await db.prepare('INSERT INTO mail_sync (account,since_epoch) VALUES (?,?)').bind('example@test.invalid',1700000000).run();
 const original=globalThis.fetch;let mode='initial',messages=0;
 globalThis.fetch=async(url,init)=>{
  const u=new URL(String(url));
  if(u.hostname==='oauth2.googleapis.com')return mode==='revoked'?Response.json({error:'invalid_grant'},{status:400}):Response.json({access_token:'test-access'});
  assert.equal(init?.method||'GET','GET');assert.equal(u.hostname,'gmail.googleapis.com');
  if(u.pathname.endsWith('/profile'))return Response.json({historyId:'10'});
  if(u.pathname.endsWith('/messages')){assert.equal(u.searchParams.get('q'),'after:1700000000');return Response.json(u.searchParams.has('pageToken')?{messages:[{id:'b'}]}:{messages:[{id:'a'}],nextPageToken:'second'});}
  if(u.pathname.endsWith('/history'))return mode==='expired'?new Response(null,{status:404}):Response.json({history:[{messagesAdded:[{message:{id:'c'}}]}],historyId:'20'});
  messages++;return Response.json({threadId:'thread',internalDate:'1700000000000',payload:{mimeType:'text/plain',headers:[{name:'Subject',value:'Course lab'}],body:{data:Buffer.from('Bring goggles').toString('base64url')}}});
 };
 try{
  assert.equal((await gmail.syncGmail()).more,true);
  assert.equal((await gmail.syncGmail()).more,false);
  assert.equal((await gmail.mailState('alice')).messages.length,2);assert.equal((await gmail.mailState('bob')).messages.length,0);
  await gmail.syncGmail();assert.equal(messages,3);
  mode='expired';assert.equal((await gmail.syncGmail()).rescan,true);assert.equal((await gmail.mailState('alice')).messages.length,3);
  mode='revoked';await assert.rejects(gmail.syncGmail());const state=await gmail.mailState('alice');assert.equal(state.status,'needs_reconnect');assert.equal(state.messages.length,3);
 }finally{globalThis.fetch=original;}
});
test('Gmail body changes invalidate the old mail vector',async()=>{
 await saveIntegrationConnection('gmail',seal({refresh:'test-refresh'}),{owner:'alice',email:'changed@test.invalid'});
 await db.prepare('INSERT INTO mail_sync (account,history_id,since_epoch) VALUES (?,?,?)').bind('changed@test.invalid','10',0).run();
 await db.prepare('INSERT INTO mail_messages (id,account,thread_id,subject,sender,body,received_at,category,attachments_json,hash) VALUES (?,?,?,?,?,?,?,?,?,?)').bind('changed-mail','changed@test.invalid','thread','Old subject','sender@test.invalid','Old body','2026-09-20T12:00:00Z','其他','[]','old-hash').run();
 await db.prepare('INSERT INTO mail_embeddings VALUES (?,?,?,?,?)').bind('changed-mail','text-embedding-3-small','subject-body-v1:old-hash',JSON.stringify(Array(768).fill(.1)),'now').run();
 const original=globalThis.fetch;
 globalThis.fetch=async(url)=>{
  const target=String(url);
  if(target.includes('oauth2.googleapis.com'))return Response.json({access_token:'test-access'});
  if(target.includes('/history?'))return Response.json({history:[{messagesAdded:[{message:{id:'changed-mail'}}]}],historyId:'11'});
  if(target.includes('/messages/changed-mail'))return Response.json({threadId:'thread',internalDate:'1789920000000',payload:{mimeType:'text/plain',headers:[{name:'Subject',value:'New subject'}],body:{data:Buffer.from('New body').toString('base64url')}}});
  throw new Error('Unexpected request: '+target);
 };
 try{await gmail.syncGmail();assert.equal(await db.prepare('SELECT 1 FROM mail_embeddings WHERE email_id=?').bind('changed-mail').first(),null);}finally{globalThis.fetch=original;}
});
