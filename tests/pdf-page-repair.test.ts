import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PDFDocument} from 'pdf-lib';
import {randomUUID} from 'node:crypto';

const directory=mkdtempSync(join(tmpdir(),'page-repair-tests-'));
process.env.DATABASE_URL=':memory:';
process.env.LIBRARY_DIR=directory;
after(()=>rmSync(directory,{recursive:true,force:true}));
const {validatePageRepairPlan,applyPageRepair,verifyAppliedPageRepair}=await import('../lib/pdf-page-repair.ts');
const {kernel}=await import('../lib/kernel/service.ts');
const {kernelPool,migrateKernel}=await import('../lib/kernel/db.ts');
const {saveDocument,getDocument,digest}=await import('../lib/library.ts');
const {selectedVisualPageCacheParser,SELECTED_VISUAL_PARSER_VERSION}=await import('../lib/document-parser.ts');
const {database}=await import('../lib/database.ts');

test('repair plan is bounded to two exact original pages before any external work',()=>{
 const target={documentId:'public-original',sourceHash:'a'.repeat(64),expectedVersion:'b'.repeat(64),pageNumbers:[2]};
 validatePageRepairPlan({owner:'public-owner',documents:[target]});
 for(const documents of [[{...target,pageNumbers:[1,2,3]}],[{...target,pageNumbers:[2,2]}],[target,target],[{...target,sourceHash:'g'.repeat(64)}]])
  assert.throws(()=>validatePageRepairPlan({owner:'public-owner',documents}),/at most two/);
});

test('page repair atomically keeps all original pages and prior evidence, and refuses a stale version',
 {skip:!process.env.KERNEL_DATABASE_URL},async()=>{
 await migrateKernel();
 const owner='public-page-repair-'+randomUUID(),pdf=await PDFDocument.create();pdf.addPage();pdf.addPage();
 const bytes=await pdf.save(),id=await saveDocument(owner,'','upload','repair-test','repair-test.pdf','application/pdf',bytes);
 const doc=await getDocument(owner,id);
 const document={id,ownerId:owner,courseId:'',name:doc.name,hash:doc.hash,mime:doc.mime,origin:doc.origin,originKey:doc.origin_key};
 await kernel.ingestParsedDocument(document,[{locator:'第 1 页',pageNumber:1,text:'Original first page'},
  {locator:'第 2 页',pageNumber:2,text:'Original second page'}],{parserVersion:'native-test',expectedPages:2,extractionMethod:'native-text'});
 const original=(await kernelPool().query('SELECT current_version_id FROM document_texts WHERE id=$1',[id])).rows[0].current_version_id as string;
 const target={documentId:id,sourceHash:doc.hash,expectedVersion:original,pageNumbers:[2]};
 const text='Faithful visual second page \\(\\psi\\)';
 const result={documentId:id,sourceHash:doc.hash,expectedVersion:original,model:'gpt-5-mini',parserVersion:SELECTED_VISUAL_PARSER_VERSION,
  pages:[{pageNumber:2,locator:'第 2 页',text,textHash:digest(text)}]};
 await assert.rejects(applyPageRepair(owner,target,result),/validated recognition cache/);
 await database.prepare('INSERT INTO library_parse_pages VALUES(?,?,?,?)').bind(id,selectedVisualPageCacheParser(doc.hash,'gpt-5-mini',true),1,text).run();
 const published=await applyPageRepair(owner,target,result);
 assert.notEqual(published.currentVersion,original);
 const old=(await kernelPool().query('SELECT body FROM document_text_pages WHERE version_id=$1 ORDER BY page_number',[original])).rows;
 assert.deepEqual(old.map(page=>page.body),['Original first page','Original second page']);
 const current=(await kernelPool().query(`SELECT p.page_number,p.body,e.parsed_value FROM document_text_pages p
  JOIN evidence e ON e.id=p.evidence_id WHERE p.version_id=$1 ORDER BY p.page_number`,[published.currentVersion])).rows;
 assert.deepEqual(current.map(page=>page.body),['Original first page',text]);
 assert.equal(current[0].parsed_value.extractionMethod,'native-text');
 assert.equal(current[1].parsed_value.extractionMethod,'ai-visual-page-transcription');
 assert.equal(current[1].parsed_value.pageProvenance.model,'gpt-5-mini');
 assert.equal(current[0].parsed_value.pageProvenance.basedOn.versionId,original);
 assert.equal(await verifyAppliedPageRepair(owner,target,result,published),true);
 await assert.rejects(verifyAppliedPageRepair(owner,target,result,{...published,currentVersion:original}),/exact current version/);
 const nextText='Second bounded repair of the first page';
 const nextTarget={...target,expectedVersion:published.currentVersion,pageNumbers:[1]};
 const nextResult={...result,expectedVersion:published.currentVersion,pages:[{pageNumber:1,locator:'第 1 页',text:nextText,textHash:digest(nextText)}]};
 await database.prepare('INSERT INTO library_parse_pages VALUES(?,?,?,?)').bind(id,selectedVisualPageCacheParser(doc.hash,'gpt-5-mini',true),0,nextText).run();
 const next=await applyPageRepair(owner,nextTarget,nextResult);
 const preserved=(await kernelPool().query(`SELECT e.parsed_value FROM document_text_pages p JOIN evidence e ON e.id=p.evidence_id
  WHERE p.version_id=$1 AND p.page_number=2`,[next.currentVersion])).rows[0].parsed_value;
 assert.equal(preserved.pageProvenance.parserVersion,SELECTED_VISUAL_PARSER_VERSION);
 assert.equal(preserved.pageProvenance.model,'gpt-5-mini','unmodified previously repaired pages keep their true model');
 const evidenceBefore=Number((await kernelPool().query('SELECT count(*) n FROM evidence WHERE source_item_id=$1',['document:'+id])).rows[0].n);
 await assert.rejects(kernel.ingestParsedDocument(document,[{locator:'第 1 页',pageNumber:1,text:'Stale overwrite'},
  {locator:'第 2 页',pageNumber:2,text:'Stale overwrite'}],{expectedPages:2,expectedCurrentVersion:original}),/changed during page repair/);
 assert.equal((await kernelPool().query('SELECT current_version_id FROM document_texts WHERE id=$1',[id])).rows[0].current_version_id,next.currentVersion);
 assert.equal(Number((await kernelPool().query('SELECT count(*) n FROM evidence WHERE source_item_id=$1',['document:'+id])).rows[0].n),evidenceBefore);
 });
