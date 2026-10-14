import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {kernel} from '../lib/kernel/service.ts';
import {kernelPool,migrateKernel} from '../lib/kernel/db.ts';
import {documentSearchText} from '../lib/kernel/document-search.ts';

test('PDF search copy normalizes ligatures, line-wrap hyphens, Unicode math and LaTeX',()=>{
  assert.match(documentSearchText('co-\nvariance ﬁnite ∫ α \\frac{x}{y}'),/covariance finite int integral alpha frac fraction x y/);
  assert.match(documentSearchText('线性代数特征值'),/特征 征值/);
});

test('full PDF text beyond evidence excerpt is searchable, scoped, versioned and rebuildable',async()=>{
  await migrateKernel();
  const tag=randomUUID(),owner=`pdf-${tag}`,course=`pdf-course-${tag}`,id=`pdf-${tag}`;
  await kernel.upsertCourse({id:course,name:'PDF acceptance',course_code:'PDF101'});
  const document={id,ownerId:owner,courseId:course,name:'Lecture.pdf',hash:tag,mime:'application/pdf',origin:'upload',originKey:id};
  const body='Introductory prose '.repeat(300)+'\nThe zephyr covariance estimator is unbiased.\n\\int_0^1 x^2 dx = \\frac{1}{3}\n线性代数特征值';
  const pages=[{locator:'第 1 页',pageNumber:1,text:'Overview'},{locator:'第 2 页',pageNumber:2,text:body}];
  await kernel.ingestParsedDocument(document,pages,{parserVersion:'test-v1',expectedPages:2});
  await kernel.ingestParsedDocument(document,pages,{parserVersion:'test-v1',expectedPages:2});
  const hits=await kernel.searchDocumentText(owner,'zephyr covariance');
  assert.equal(hits[0].document_id,id);
  assert.equal(hits[0].page_number,2);
  assert.match(hits[0].body,/zephyr covariance/);
  assert.ok(hits[0].evidence_id);
  assert.equal((await kernel.parsedDocument(owner,id))[1].body,body);
  assert.equal((await kernel.searchDocumentText('other','zephyr covariance')).length,0);
  assert.equal((await kernel.searchDocumentText(owner,'zephyr covariance',{courseId:'other'})).length,0);
  assert.ok((await kernel.searchDocumentText(owner,'integral fraction')).some(hit=>hit.page_number===2));
  assert.ok((await kernel.searchDocumentText(owner,'特征值')).some(hit=>hit.page_number===2));
  assert.equal(Number((await kernelPool().query('SELECT count(*) FROM document_text_versions WHERE document_id=$1',[id])).rows[0].count),1);
  await kernelPool().query('DELETE FROM document_text_chunks WHERE version_id IN (SELECT id FROM document_text_versions WHERE document_id=$1)',[id]);
  assert.equal((await kernel.searchDocumentText(owner,'zephyr covariance'))[0].page_number,2,'full-page search survives a missing snippet cache');
  await kernelPool().query("UPDATE document_text_pages SET search_text='' WHERE version_id IN (SELECT id FROM document_text_versions WHERE document_id=$1)",[id]);
  assert.equal((await kernel.searchDocumentText(owner,'zephyr covariance')).length,0);
  await kernel.rebuildDocumentSearch(owner,id);
  assert.equal((await kernel.searchDocumentText(owner,'zephyr covariance'))[0].page_number,2);
  await assert.rejects(kernel.ingestParsedDocument(document,[pages[0]],{expectedPages:2}),/incomplete/);
  assert.equal((await kernel.searchDocumentText(owner,'zephyr covariance'))[0].page_number,2);
  await kernel.ingestParsedDocument(document,[pages[0],{...pages[1],text:'The nebula regression estimator replaces the prior formulation.'}],{parserVersion:'test-v2'});
  assert.equal((await kernel.searchDocumentText(owner,'zephyr',{strict:true})).length,0);
  assert.ok((await kernel.searchDocumentText(owner,'nebula regression')).length);
  assert.equal(Number((await kernelPool().query('SELECT count(*) FROM document_text_versions WHERE document_id=$1',[id])).rows[0].count),2);
  await kernel.hideParsedDocument(owner,id);
  assert.equal((await kernel.searchDocumentText(owner,'nebula regression')).length,0);
});

test('library query and preview use PostgreSQL even after disposable SQLite chunks are removed',async()=>{
  await migrateKernel();
  const lib=await import('../lib/library.ts');
  const {database}=await import('../lib/database.ts');
  const owner=`library-${randomUUID()}`;
  const id=await lib.saveDocument(owner,'','upload','long.pdf','long.pdf','application/pdf',Buffer.from('%PDF-1.4 original preserved'));
  const row=await lib.getDocument(owner,id);
  await kernel.ingestParsedDocument({id,ownerId:owner,courseId:'',name:row.name,hash:row.hash,mime:row.mime,origin:row.origin,originKey:row.origin_key},
    [{pageNumber:1,locator:'第 1 页',text:'Durable aurora interpolation information.'}],{parserVersion:'test'});
  await database.prepare("UPDATE library_documents SET status='ready' WHERE id=?").bind(id).run();
  const hits=await lib.searchLibrary(owner,'aurora interpolation','',false);
  assert.equal(hits[0].document_id,id);
  assert.equal(hits[0].page_number,1);
  assert.equal((await lib.searchLibrary(owner,'aurora interpolation','',false,{strict:true}))[0].document_id,id);
  assert.equal((await lib.previewDocument(owner,id)).pages[0].text,'Durable aurora interpolation information.');
  await lib.removeDocument(owner,id);
  assert.equal((await lib.searchLibrary(owner,'aurora interpolation','',false)).length,0);
});

test('strict library content search rejects stale SQLite text after a PostgreSQL reparse',async()=>{
  await migrateKernel();
  const lib=await import('../lib/library.ts');
  const {database}=await import('../lib/database.ts');
  const owner=`strict-current-${randomUUID()}`;
  const id=await lib.saveDocument(owner,'','upload','current.pdf','RevisionProof.pdf','application/pdf',Buffer.from('%PDF-1.4 original'));
  const row=await lib.getDocument(owner,id);
  const document={id,ownerId:owner,courseId:'',name:row.name,hash:row.hash,mime:row.mime,origin:row.origin,originKey:row.origin_key};
  await kernel.ingestParsedDocument(document,[{pageNumber:1,locator:'第 1 页',text:'Obsolete zephyr draft.'}],{parserVersion:'before',expectedPages:1});
  await database.prepare('INSERT INTO library_chunks VALUES (?,?,?,?,?,?)').bind(`${id}:old`,id,0,'第 1 页','Obsolete zephyr draft.','old-cache').run();
  await database.prepare("UPDATE library_documents SET status='ready' WHERE id=?").bind(id).run();
  await kernel.ingestParsedDocument(document,[{pageNumber:1,locator:'第 1 页',text:'Current nebula final.'}],{parserVersion:'after',expectedPages:1});
  assert.deepEqual(await lib.searchLibrary(owner,'obsolete zephyr','',false,{strict:true}),[]);
  const current=await lib.searchLibrary(owner,'current nebula','',false,{strict:true});
  const canonical=(await kernel.searchDocumentText(owner,'current nebula',{strict:true}))[0];
  assert.equal(current[0].evidence_id,canonical.evidence_id);
  assert.equal(current[0].source_version_id,canonical.source_version_id);
  assert.equal(current[0].source_hash,row.hash);
  assert.equal(current[0].page_number,1);
  const metadata=await lib.searchLibrary(owner,'RevisionProof','',false,{strict:true,metadataFirst:true});
  assert.equal(metadata[0].document_id,id);
  assert.doesNotMatch(metadata[0].body,/obsolete zephyr/i);
});

test('a database interruption cannot publish half a PDF or its source evidence',async()=>{
  await migrateKernel();
  const id=`interrupted-${randomUUID()}`;
  await kernelPool().query(`CREATE OR REPLACE FUNCTION fail_pdf_test_chunk() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.body='intentional failure' THEN RAISE EXCEPTION 'intentional interruption'; END IF; RETURN NEW; END $$`);
  await kernelPool().query('CREATE TRIGGER fail_pdf_test_chunk BEFORE INSERT ON document_text_chunks FOR EACH ROW EXECUTE FUNCTION fail_pdf_test_chunk()');
  try{
    await assert.rejects(kernel.ingestParsedDocument({id,ownerId:'test',courseId:'',name:'retry.pdf',hash:id,mime:'application/pdf',origin:'upload',originKey:id},
      [{locator:'第 1 页',text:'first page'},{locator:'第 2 页',text:'intentional failure'}]),/intentional interruption/);
    assert.equal(Number((await kernelPool().query('SELECT count(*) FROM source_items WHERE id=$1',[`document:${id}`])).rows[0].count),0);
    assert.equal((await kernel.parsedDocument('test',id)).length,0);
  }finally{
    await kernelPool().query('DROP TRIGGER fail_pdf_test_chunk ON document_text_chunks');
    await kernelPool().query('DROP FUNCTION fail_pdf_test_chunk()');
  }
});

test('equal capture times choose the same PDF identity in PostgreSQL and the library cache',async()=>{
  await migrateKernel();
  const lib=await import('../lib/library.ts');
  const {database}=await import('../lib/database.ts');
  const owner=`equal-time-${randomUUID()}`,originKey=`revision-${randomUUID()}`;
  const ids=await Promise.all(['first','second'].map(label=>lib.saveDocument(owner,'','upload',originKey,
    'Revision.pdf','application/pdf',Buffer.from(`%PDF-1.4 original ${label}`))));
  const selected=[...ids].sort().at(-1)!;
  const other=ids.find(id=>id!==selected)!;
  const capturedAt='2026-01-01T12:00:00.000Z';
  // Deliberately make SQLite insertion order disagree with the stable ID tie rule.
  await database.prepare('UPDATE library_documents SET rowid=1000000 WHERE id=?').bind(other).run();
  for(const id of ids){
    await database.prepare("UPDATE library_documents SET created_at=?,status='ready' WHERE id=?").bind(capturedAt,id).run();
    const row=await lib.getDocument(owner,id);
    await kernel.ingestParsedDocument({id,ownerId:owner,courseId:'',name:row.name,hash:row.hash,mime:row.mime,
      origin:row.origin,originKey:row.origin_key,createdAt:capturedAt},
      [{pageNumber:1,locator:'第 1 页',text:'Quartz phase diagram searchable evidence.'}],{parserVersion:'equal-time-test',expectedPages:1});
  }
  const query='quartz phase diagram';
  const core=await kernel.searchDocumentText(owner,query,{limit:5});
  const compatible=await lib.searchLibrary(owner,query,'',false,{limit:5});
  assert.deepEqual(core.map(hit=>hit.document_id),[selected]);
  assert.deepEqual(compatible.map(hit=>hit.document_id),[selected]);
  assert.equal(compatible[0].evidence_id,core[0].evidence_id);
  assert.equal(compatible[0].page_number,1);
});

test('technical identifiers remain searchable without an invented course filter',async()=>{
  await migrateKernel();
  const lib=await import('../lib/library.ts');
  const {database}=await import('../lib/database.ts');
  const tag=randomUUID(),owner=`identifier-${tag}`,courseId=`identifier-course-${tag}`;
  await kernel.upsertCourse({id:courseId,name:'Computer systems',course_code:'SCI123'});
  const id=await lib.saveDocument(owner,courseId,'upload','numbers.pdf','Numbers.pdf',
    'application/pdf',Buffer.from('%PDF-1.4 test scientific identifiers'));
  const row=await lib.getDocument(owner,id);
  await kernel.ingestParsedDocument({id,ownerId:owner,courseId,name:row.name,hash:row.hash,mime:row.mime,
    origin:row.origin,originKey:row.origin_key},
    [{pageNumber:1,locator:'第 1 页',text:'IEEE754 explains floating point rounding and representation.'}],
    {parserVersion:'identifier-test',expectedPages:1});
  await database.prepare("UPDATE library_documents SET status='ready' WHERE id=?").bind(id).run();
  assert.equal((await lib.searchLibrary(owner,'IEEE754 rounding','',false))[0].document_id,id);
  assert.equal((await lib.searchLibrary(owner,'SCI123 IEEE754 rounding','',false))[0].document_id,id);
  assert.deepEqual(await lib.searchLibrary(owner,'IEEE754 rounding','unknown-course',false),[]);
  assert.deepEqual(await lib.searchLibrary('other-'+owner,'IEEE754 rounding','',false),[]);
});
