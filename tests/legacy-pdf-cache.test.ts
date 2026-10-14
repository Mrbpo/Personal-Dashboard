import {after,test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {PDFDocument} from 'pdf-lib';
import {auditLegacyPdfCache,applyLegacyPdfCache} from '../lib/kernel/legacy-pdf-cache.ts';
import {kernel} from '../lib/kernel/service.ts';
import {kernelPool,migrateKernel} from '../lib/kernel/db.ts';

after(async()=>{await kernelPool().end();});
test('legacy import validates physical coverage, retains evidence and cannot win a race against a new parse',async()=>{
 await migrateKernel();
 const pdf=await PDFDocument.create();pdf.addPage().drawText('First source page');pdf.addPage();
 const bytes=await pdf.save(),hash=createHash('sha256').update(bytes).digest('hex'),tag=randomUUID();
 const document={id:`legacy-cache-${tag}`,owner_id:`legacy-cache-owner-${tag}`,course_id:'',name:'Legacy fixture.pdf',hash,
  mime:'application/pdf',origin:'upload',origin_key:tag,created_at:new Date().toISOString(),status:'ready',error:null};
 const rows=[{parser:'pdf-page-v2',page:0,body:'First source page'},{parser:'pdf-page-v2',page:1,body:''}];
 const audited=await auditLegacyPdfCache(document,rows,bytes);
 assert.equal(audited.decision,'eligible','original truly blank page is retained');
 assert.equal((await auditLegacyPdfCache(document,[rows[0]],bytes)).decision,'needs_parse');
 assert.equal((await auditLegacyPdfCache(document,rows.map(row=>({...row,parser:'docling-v1'})),bytes)).decision,'needs_parse');
 assert.equal((await auditLegacyPdfCache({...document,hash:'0'.repeat(64)},rows,bytes)).originalPages,null);
 assert.equal((await applyLegacyPdfCache(document,audited)).action,'imported');
 assert.equal((await applyLegacyPdfCache(document,audited)).action,'already-imported');
 const old=(await kernel.parsedDocument(document.owner_id,document.id));
 assert.equal(old[0].body,rows[0].body);assert.equal(old[1].body,'');assert.match(old[0].warnings.join(' '),/旧缓存公式/);
 const evidence=(await kernelPool().query(`SELECT s.raw_sha256,s.raw_uri,e.locator FROM document_texts d
  JOIN document_text_versions v ON v.id=d.current_version_id JOIN source_item_versions s ON s.id=v.source_version_id
  JOIN document_text_pages p ON p.version_id=v.id JOIN evidence e ON e.id=p.evidence_id WHERE d.id=$1 ORDER BY p.page_number`,[document.id])).rows;
 assert.equal(evidence[0].raw_sha256,hash);assert.equal(evidence[0].raw_uri,`library://${hash}`);assert.equal(evidence[1].locator,'第 2 页');
 const canonical={id:document.id,ownerId:document.owner_id,courseId:'',name:document.name,hash,mime:document.mime,origin:document.origin,originKey:tag};
 await kernel.ingestParsedDocument(canonical,[{locator:'Page 1',text:'New current complete source page'},{locator:'Page 2',text:''}],{parserVersion:'fresh-test'});
 assert.equal((await applyLegacyPdfCache(document,audited)).action,'protected-current-head');
 assert.equal((await kernel.parsedDocument(document.owner_id,document.id))[0].body,'New current complete source page');
 assert.equal(Number((await kernelPool().query('SELECT count(*) n FROM document_text_versions WHERE document_id=$1',[document.id])).rows[0].n),2);

 // Both normal parsing and legacy import use the same transaction advisory lock.
 // The first normal parse waits before publishing; the stale empty-head import
 // must subsequently reject, rather than overwriting the newly committed head.
 const racing={...document,id:`legacy-racing-${tag}`,origin_key:`race-${tag}`};
 const raceAudit=await auditLegacyPdfCache(racing,rows,bytes),pool=kernelPool(),gate=await pool.connect();
 const lock=async()=>Number((await pool.query(`SELECT count(*) n FROM pg_locks WHERE locktype='advisory' AND NOT granted
  AND objid=(hashtext($1)::bigint & 4294967295)::oid`,[`document:${racing.id}`])).rows[0].n);
 try{
  await gate.query('BEGIN');await gate.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`document:${racing.id}`]);
  const fresh=kernel.ingestParsedDocument({...canonical,id:racing.id,originKey:racing.origin_key},
   [{locator:'Page 1',text:'Concurrent new source page'},{locator:'Page 2',text:''}],{parserVersion:'fresh-race-test'});
  for(let i=0;i<100&&await lock()<1;i++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(await lock(),1);
  const legacy=applyLegacyPdfCache(racing,raceAudit);
  const rejected=assert.rejects(legacy,/Document changed during page repair/);
  for(let i=0;i<100&&await lock()<2;i++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(await lock(),2);await gate.query('COMMIT');
  await fresh;await rejected;
  assert.equal((await kernel.parsedDocument(racing.owner_id,racing.id))[0].body,'Concurrent new source page');
 }finally{await gate.query('ROLLBACK');gate.release();}
});
