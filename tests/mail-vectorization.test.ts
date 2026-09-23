import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

process.env.DATABASE_URL=':memory:';
process.env.AI_BUDGET_TEST_BYPASS='true';
process.env.OPENAI_API_KEY='test-key';
process.env.GMAIL_CLIENT_ID='test-client';
process.env.GMAIL_CLIENT_SECRET='test-secret';
process.env.GMAIL_REDIRECT_URI='http://localhost:3000/api/mail/callback';
const directory=mkdtempSync(join(tmpdir(),'mail-vectors-'));
process.env.LIBRARY_DIR=directory;

const {database:db,mailSearchIndexAvailable}=await import('../lib/database.ts');
const {saveIntegrationConnection}=await import('../lib/repository.ts');
const {seal}=await import('../lib/service-vault.ts');
const {archiveMail}=await import('../lib/mail-library.ts');
const library=await import('../lib/library.ts');
const {searchRelatedMail}=await import('../lib/mail-intelligence.ts');
const {ensureMailEmbedding,retireMailEmbedding}=await import('../lib/mail-embedding.ts');
const sha=(subject:string,body:string)=>createHash('sha256').update(subject+body).digest('hex');

test('archived mail shares one subject/body vector, keeps full-text tail recall, and leaves attachments independent',async()=>{
 const original=globalThis.fetch,embeddingInputs:string[][]=[];
 globalThis.fetch=async(url,init)=>{
  const target=String(url);
  if(target.endsWith('/embeddings')){const raw=JSON.parse(String(init?.body)).input as string|string[],input=Array.isArray(raw)?raw:[raw];embeddingInputs.push(input);return Response.json({data:input.map((_:string,index:number)=>({index,embedding:Array(768).fill(.1)}))});}
  if(target.endsWith('/token'))return Response.json({access_token:'test-token'});
  if(target.includes('/attachments/att-1'))return Response.json({data:Buffer.from('independent attachment keyword').toString('base64url')});
  throw new Error('Unexpected request: '+target);
 };
 try{
  await saveIntegrationConnection('gmail',seal({refresh:'test-refresh'}),{owner:'alice',email:'alice@example.invalid'});
  await db.prepare("INSERT INTO courses (id,name,code,updated_at) VALUES ('chem','Chemistry','CHMA10','now')").run();
  const subject='CHMA10 schedule',body='lecture overview '.repeat(450)+' quarterfactverified '+'lecture overview '.repeat(1350)+' tailfactconfirmed';
  await db.prepare('INSERT INTO mail_messages (id,account,thread_id,subject,sender,body,received_at,category,attachments_json,hash) VALUES (?,?,?,?,?,?,?,?,?,?)').bind('mail-new','alice@example.invalid','thread-1',subject,'teacher@example.edu',body,'2026-09-23T12:00:00Z','学习',JSON.stringify([{id:'att-1',name:'notes.txt',size:30,mime:'text/plain'}]),sha(subject,body)).run();
  await db.prepare('INSERT INTO mail_messages (id,account,thread_id,subject,sender,body,received_at,category,attachments_json,hash) VALUES (?,?,?,?,?,?,?,?,?,?)').bind('mail-old','alice@example.invalid','thread-2','Old announcement','other@example.edu','A past message says tailfactconfirmed was checked.','2020-01-01T12:00:00Z','学习','[]',sha('Old announcement','A past message says tailfactconfirmed was checked.')).run();
  await db.prepare('INSERT INTO mail_messages (id,account,thread_id,subject,sender,body,received_at,category,attachments_json,hash) VALUES (?,?,?,?,?,?,?,?,?,?)').bind('mail-quarter','alice@example.invalid','thread-quarter','Older independent note','third@example.edu','The only shared detail is quarterfactverified.','2019-01-01T12:00:00Z','学习','[]',sha('Older independent note','The only shared detail is quarterfactverified.')).run();
  await db.prepare('INSERT INTO mail_messages (id,account,thread_id,subject,sender,body,received_at,category,attachments_json,hash) VALUES (?,?,?,?,?,?,?,?,?,?)').bind('foreign-mail','bob@example.invalid','foreign-thread','Quarter fact','fourth@example.edu','quarterfactverified','2026-09-23T14:00:00Z','学习','[]',sha('Quarter fact','quarterfactverified')).run();
  assert.equal(await mailSearchIndexAvailable(),true);
  assert.ok(await db.prepare("SELECT 1 FROM mail_messages_fts JOIN mail_messages m ON m.rowid=mail_messages_fts.rowid WHERE mail_messages_fts MATCH 'quarterfactverified' AND m.id='mail-new'").first());
  const archived=await archiveMail('alice','mail-new','chem');
  await library.indexDocument('alice',archived.id);
  const chunks=await db.prepare('SELECT COUNT(*) n FROM library_chunks WHERE document_id=?').bind(archived.id).first<{n:number}>();assert.equal(chunks!.n,22);
  assert.equal(await library.embedMissing('alice'),1);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM mail_embeddings WHERE email_id=?').bind('mail-new').first<{n:number}>())?.n,1);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM library_vectors WHERE chunk_id IN (SELECT id FROM library_chunks WHERE document_id=?)').bind(archived.id).first<{n:number}>())?.n,0);
  assert.equal(embeddingInputs.length,1);
  assert.equal(embeddingInputs[0].length,1);
  assert.match(embeddingInputs[0][0],/CHMA10 schedule/);
  assert.match(embeddingInputs[0][0],/tailfactconfirmed/);
  assert.doesNotMatch(embeddingInputs[0][0],/quarterfactverified/,'the middle fact is recovered lexically, beyond the sampled vector input');
  assert.equal(await ensureMailEmbedding('alice@example.invalid','mail-new'),false);
  assert.equal(embeddingInputs.length,1);
  assert.equal((await library.searchLibrary('alice','tailfactconfirmed','chem',false))[0]?.document_id,archived.id);
  const semanticHit=(await library.searchLibrary('alice','tailfactconfirmed','chem',true))[0];
  assert.equal(semanticHit?.document_id,archived.id);
  assert.match(semanticHit?.body||'',/tailfactconfirmed/);
  const documentHits=await library.searchLibrary('alice','unseenconceptzz','chem',true),documentHit=documentHits.find(hit=>hit.document_id===archived.id);
  assert.equal(documentHit?.body,'',JSON.stringify(documentHits.map(hit=>({id:hit.document_id,locator:hit.locator,score:hit.score}))));
  assert.match(documentHit?.locator||'',/段落未定位/);
  assert.match(documentHit?.match_reason||'',/段落未定位/);
  assert.equal((await searchRelatedMail('alice','mail-new')).some(hit=>hit.id==='mail-old'),true);
  assert.equal((await searchRelatedMail('alice','mail-new')).some(hit=>hit.id==='mail-quarter'),true);
  assert.equal((await searchRelatedMail('alice','mail-new')).some(hit=>hit.id==='foreign-mail'),false);
  await db.batch(Array.from({length:1500},(_,index)=>db.prepare('INSERT INTO mail_messages (id,account,thread_id,subject,sender,body,received_at,category,attachments_json,hash) VALUES (?,?,?,?,?,?,?,?,?,?)').bind(`boilerplate-${index}`,'alice@example.invalid',`noise-${index}`,'Routine notice','notice@example.edu','lecture overview','2026-09-22T12:00:00Z','其他','[]',`noise-${index}`)));
  const basePrepare=db.prepare;let ftsQueries=0,fallbackQueries=0;
  db.prepare=(sql:string)=>{if(sql.startsWith('WITH candidates AS MATERIALIZED'))ftsQueries++;if(sql.startsWith('SELECT * FROM (SELECT m.id'))fallbackQueries++;return basePrepare(sql);};
  let crowdedRelated:Awaited<ReturnType<typeof searchRelatedMail>>;
  try{crowdedRelated=await searchRelatedMail('alice','mail-new');}finally{db.prepare=basePrepare;}
  assert.ok(ftsQueries>0);
  assert.equal(fallbackQueries,0,'the indexed query should run without scanning every mail body');
  assert.equal(crowdedRelated.some(hit=>hit.id==='mail-old'),true,'an old, specific body match must survive recent boilerplate');
  assert.equal(crowdedRelated.some(hit=>hit.id==='mail-quarter'),true,'a fact in the middle of a long email must be selected');
  const beforeConcurrent=embeddingInputs.length;
  await Promise.all([ensureMailEmbedding('alice@example.invalid','mail-old'),ensureMailEmbedding('alice@example.invalid','mail-old')]);
  assert.equal(embeddingInputs.length-beforeConcurrent,1);
  await db.prepare('INSERT INTO mail_messages (id,account,thread_id,subject,sender,body,received_at,category,attachments_json,hash) VALUES (?,?,?,?,?,?,?,?,?,?)').bind('mail-stale','alice@example.invalid','thread-3','Unrelated notice','unrelated@example.edu','Nothing in common.','2026-09-23T13:00:00Z','其他','[]',sha('Unrelated notice','Nothing in common.')).run();
  await db.prepare('INSERT INTO mail_embeddings VALUES (?,?,?,?,?)').bind('mail-stale','text-embedding-3-small','stale-hash',JSON.stringify(Array(768).fill(.1)),'now').run();
  assert.equal((await searchRelatedMail('alice','mail-new')).some(hit=>hit.id==='mail-stale'),false);
  assert.equal((await library.searchLibrary('bob','tailfactconfirmed','chem',false)).length,0);
  await assert.rejects(searchRelatedMail('bob','mail-new'),/邮箱未连接/);

  const attachment=await archiveMail('alice','mail-new','chem',0);
  await library.indexDocument('alice',attachment.id);
  assert.equal(await library.embedMissing('alice'),1);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM library_vectors WHERE chunk_id IN (SELECT id FROM library_chunks WHERE document_id=?)').bind(attachment.id).first<{n:number}>())?.n,1);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM library_mail_sources WHERE document_id=?').bind(attachment.id).first<{n:number}>())?.n,0);
  assert.equal((await library.searchLibrary('alice','independent attachment keyword','chem',false))[0]?.document_id,attachment.id);

  await db.prepare("INSERT INTO courses (id,name,code,updated_at) VALUES ('bio','Biology','BIOA01','now')").run();
  const secondArchive=await archiveMail('alice','mail-new','bio');
  await library.indexDocument('alice',secondArchive.id);
  assert.equal(await library.embedMissing('alice'),0,'two course archives share the same mail vector');

  const updatedSubject='CHMA10 revised schedule',updatedBody='Revised details replace the old notice. newtailfact';
  await retireMailEmbedding('alice@example.invalid','mail-new',sha(subject,body));
  await db.prepare('UPDATE mail_messages SET subject=?,body=?,hash=? WHERE id=? AND account=?').bind(updatedSubject,updatedBody,sha(updatedSubject,updatedBody),'mail-new','alice@example.invalid').run();
  assert.equal(await db.prepare("SELECT 1 FROM mail_messages_fts JOIN mail_messages m ON m.rowid=mail_messages_fts.rowid WHERE mail_messages_fts MATCH 'quarterfactverified' AND m.id='mail-new'").first(),null);
  assert.ok(await db.prepare('SELECT 1 FROM mail_embedding_versions WHERE account=? AND email_id=? AND source_hash=?').bind('alice@example.invalid','mail-new',sha(subject,body)).first());
  const historicalHit=(await library.searchLibrary('alice','unseenhistoryconcept','chem',true)).find(hit=>hit.document_id===archived.id);
  assert.equal(historicalHit?.body,'');
  assert.match(historicalHit?.locator||'',/段落未定位/);
  const revised=await archiveMail('alice','mail-new','chem');assert.notEqual(revised.id,archived.id);
  await library.indexDocument('alice',revised.id);
  assert.equal(await library.embedMissing('alice'),1);
  assert.equal((await library.searchLibrary('alice','newtailfact','chem',false))[0]?.document_id,revised.id);
  assert.equal((await library.searchLibrary('alice','tailfactconfirmed','chem',false)).some(hit=>hit.document_id===archived.id),false);
  await library.removeDocument('alice',revised.id);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM library_mail_sources WHERE document_id=?').bind(revised.id).first<{n:number}>())?.n,0);
  assert.equal((await library.searchLibrary('alice','newtailfact','chem',false)).some(hit=>hit.document_id===revised.id),false);

  // Older archives have no source mapping. Preserve their own chunk vectors
  // if the Gmail message changes after archiving.
  const legacySubject='Legacy title',legacyBody='legacyoldfact';
  await db.prepare('INSERT INTO mail_messages (id,account,thread_id,subject,sender,body,received_at,category,attachments_json,hash) VALUES (?,?,?,?,?,?,?,?,?,?)').bind('mail-legacy','alice@example.invalid','thread-4',legacySubject,'teacher@example.edu',legacyBody,'2020-01-02T12:00:00Z','学习','[]',sha(legacySubject,legacyBody)).run();
  const legacy=await library.saveDocument('alice','chem','gmail','alice@example.invalid/mail-legacy/body','Legacy title.txt','text/plain',Buffer.from(`${legacySubject}\nteacher@example.edu\n2020-01-02T12:00:00Z\n\n${legacyBody}`));
  await library.indexDocument('alice',legacy);assert.equal(await library.embedMissing('alice'),1);
  await db.prepare('UPDATE mail_messages SET body=?,hash=? WHERE id=?').bind('changed after archive',sha(legacySubject,'changed after archive'),'mail-legacy').run();
  assert.equal(await library.embedMissing('alice'),0);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM library_vectors WHERE chunk_id IN (SELECT id FROM library_chunks WHERE document_id=?)').bind(legacy).first<{n:number}>())?.n,1);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM library_mail_sources WHERE document_id=?').bind(legacy).first<{n:number}>())?.n,0);
  assert.equal((await library.searchLibrary('alice','legacyoldfact','chem',false))[0]?.document_id,legacy);
  const legacySemantic=(await library.searchLibrary('alice','legacysemanticconcept','chem',true)).find(hit=>hit.document_id===legacy);
  assert.match(legacySemantic?.body||'',/legacyoldfact/,'old archives retain their original chunk semantic search after Gmail updates');
  await library.removeDocument('alice',archived.id);
  await library.collectUnusedBlobs();
  assert.ok(await db.prepare('SELECT 1 FROM mail_embedding_versions WHERE email_id=? AND source_hash=?').bind('mail-new',sha(subject,body)).first(),'another course archive still references the old vector');
  await library.removeDocument('alice',secondArchive.id);
  await library.collectUnusedBlobs();
  assert.equal(await db.prepare('SELECT 1 FROM mail_embedding_versions WHERE email_id=? AND source_hash=?').bind('mail-new',sha(subject,body)).first(),null,'the last historical archive reference releases its vector');
 }finally{globalThis.fetch=original;rmSync(directory,{recursive:true,force:true});}
});
