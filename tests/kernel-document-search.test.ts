import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {kernel} from '../lib/kernel/service.ts';
import {kernelPool,migrateKernel} from '../lib/kernel/db.ts';
import {documentSearchText,documentSearchTerms,type DocumentSearchOptions} from '../lib/kernel/document-search.ts';

test('PDF search copy normalizes ligatures, line-wrap hyphens, Unicode math and LaTeX',()=>{
  assert.match(documentSearchText('co-\nvariance ﬁnite ∫ α \\frac{x}{y}'),/covariance finite int integral alpha frac fraction x y/);
  assert.match(documentSearchText('线性代数特征值'),/特征 征值/);
});

test('literal decimals rank current owned pages and their matching excerpts without rebuilding stored search copies',async()=>{
 await migrateKernel();const tag=randomUUID(),owner=`decimal-${tag}`,course=`decimal-course-${tag}`,id=`decimal-document-${tag}`;
 await kernel.upsertCourse({id:course,name:'Decimal scope',course_code:'DEC-'+tag});
 const texts=[
  'target domain '.repeat(70)+'reports 2.3% and 3.7%.',
  'target domain '.repeat(120)+'Target domain improvements are 2.2% on laptops and 3.6% on restaurants.',
  'target domain changes are -2.2% and -3.6%.',
  'target domain reports 2.20% and 3.60%.',
  'target domain reports 12.2% and 13.6%.',
  'target domain reports ２．２ ％ and ３．６％.',
 ];
 const doc={id,ownerId:owner,courseId:course,name:'Domain.pdf',hash:tag,mime:'application/pdf',origin:'upload',originKey:id};
 await kernel.ingestParsedDocument(doc,texts.map((text,i)=>({pageNumber:i+1,locator:`Page ${i+1}`,text})),{parserVersion:'decimal-fixture',expectedPages:texts.length});
 await kernel.ingestParsedDocument({...doc,id:id+'-foreign',ownerId:'foreign-'+owner,originKey:id+'-foreign'},[{pageNumber:1,locator:'Page 1',text:'target domain 2.2% 3.6%'}],{parserVersion:'decimal-fixture',expectedPages:1});
 const stale={...doc,id:id+'-stale',originKey:id+'-stale'};
 await kernel.ingestParsedDocument(stale,[{pageNumber:1,locator:'Page 1',text:'target domain 2.2% 3.6%'}],{parserVersion:'decimal-old',expectedPages:1});
 await kernel.ingestParsedDocument(stale,[{pageNumber:1,locator:'Page 1',text:'unrelated current information'}],{parserVersion:'decimal-current',expectedPages:1});
 const options={courseId:course,semantic:false,hybrid:false,aiRerank:false,relatedDocuments:false,limit:10};
 const broad=await kernel.searchDocumentText(owner,'target domain 2.2% 3.6%',options);
 assert.equal(broad[0].document_id,id);assert.ok([2,6].includes(broad[0].page_number));
 const p2=broad.find(h=>h.document_id===id&&h.page_number===2)!;assert.ok(p2.body.includes('2.2%')&&p2.body.includes('3.6%'),'snippet follows the same numeric conditions as page ranking');
 assert.ok(broad.every(h=>h.document_id!==id+'-foreign'&&h.document_id!==stale.id));
 const exact=await kernel.searchDocumentText(owner,'target domain 2.2% 3.6%',{...options,strict:true});
 assert.deepEqual(exact.map(h=>h.page_number).sort(),[2,6]);
 assert.deepEqual((await kernel.searchDocumentText(owner,'target domain -2.2% -3.6%',{...options,strict:true})).map(h=>h.page_number),[3]);
 assert.deepEqual((await kernel.searchDocumentText(owner,'target domain 2.20% 3.60%',{...options,strict:true})).map(h=>h.page_number),[4]);
 assert.deepEqual(await kernel.searchDocumentText('unknown-'+owner,'target domain 2.2% 3.6%',{...options,strict:true}),[]);
 const stored=(await kernelPool().query<{search_text:string}>('SELECT search_text FROM document_text_pages WHERE version_id=(SELECT current_version_id FROM document_texts WHERE id=$1) ORDER BY page_number',[id])).rows;
 assert.deepEqual(stored.map(r=>r.search_text),texts.map(documentSearchText));
});

test('strict short formula and numeric queries find current indexed pages without an index rebuild',async()=>{
  await migrateKernel();
  const tag=randomUUID(),owner=`short-query-${tag}`,id=`short-query-document-${tag}`;
  const texts=['The recurrence is 4T(n/4) 5n.','A different recurrence is 7S(k/3) 8k.','The standalone count is 9.'];
  await kernel.ingestParsedDocument({id,ownerId:owner,courseId:'',name:'Recurrences.pdf',hash:tag,
    mime:'application/pdf',origin:'upload',originKey:id},
    texts.map((text,index)=>({pageNumber:index+1,locator:`Page ${index+1}`,text})),
    {parserVersion:'short-query-test',expectedPages:3});
  for(const [query,page] of [['4T(n/4) 5n',1],['7S(k/3) 8k',2],['9',3],['t',1]] as const){
    const hits=await kernel.searchDocumentText(owner,query,{strict:true});
    assert.deepEqual(hits.map(hit=>hit.page_number),[page]);
    assert.equal(hits[0].document_id,id);
    assert.equal(hits[0].body,texts[page-1]);
  }
  assert.deepEqual(await kernel.searchDocumentText('other-'+owner,'4T(n/4) 5n',{strict:true}),[]);
  const stored=await kernelPool().query<{search_text:string}>(
    'SELECT p.search_text FROM document_text_pages p JOIN document_texts d ON d.current_version_id=p.version_id WHERE d.id=$1 ORDER BY p.page_number',[id]);
  assert.deepEqual(stored.rows.map(row=>row.search_text),texts.map(documentSearchText));
});

test('indexed page ranking preserves legacy scores, snippets and current visible scopes before limiting bodies',async()=>{
  await migrateKernel();
  // Frozen pre-optimization SQL from9a1f6b3, with trailing spaces removed. It is executed
  // only over this small synthetic fixture, never against the timed-out corpus.
  const legacy=readFileSync(new URL('./fixtures/document-search-legacy.sql',import.meta.url),'utf8').replace(/\r\n/g,'\n');
  assert.equal(createHash('sha256').update(legacy).digest('hex'),'ea7e598b9b1ab90a2fb618c062b55b8fcbd837064048cad391fc732d130d84ba');
  const tag=randomUUID(),owner=`ranking-${tag}`,course=`ranking-course-${tag}`,otherCourse=`ranking-other-${tag}`;
  await kernel.upsertCourse({id:course,name:'Ranking regression',course_code:'RANK-'+tag});
  await kernel.upsertCourse({id:otherCourse,name:'Other ranking course',course_code:'OTHER-'+tag});
  const add=async(suffix:string,texts:string[],extras:Record<string,string>={})=>{
    const document={id:`ranking-${tag}-${suffix}`,ownerId:owner,courseId:course,name:suffix+'.pdf',hash:tag+'-'+suffix,
      mime:'application/pdf',origin:'upload',originKey:suffix,...extras};
    await kernel.ingestParsedDocument(document,texts.map((text,index)=>({pageNumber:index+1,locator:`Page ${index+1}`,text})),
      {parserVersion:'ranking-test',expectedPages:texts.length});
    return document;
  };
  const main=await add('main',['quartz quartz quartz orbit','nonmatching long collection context '.repeat(35)]);
  await add('second',['quartz orbit orbit transit orbit']);
  await add('third',['quartz solitary']);
  await add('other-course',['quartz orbit transit quartz orbit extra'],{courseId:otherCourse});
  await add('other-owner',['quartz orbit '.repeat(20)],{ownerId:'other-'+owner});
  const hidden=await add('hidden',['quartz orbit '.repeat(15)]);await kernel.hideParsedDocument(owner,hidden.id);
  const changed=await add('changed',['obsolete quartz orbit '.repeat(10)]);
  await kernel.ingestParsedDocument(changed,[{pageNumber:1,locator:'Page 1',text:'current quartz orbit orbit signal'}],{parserVersion:'ranking-current',expectedPages:1});
  const originKey=`same-origin-${tag}`,createdAt='2026-01-01T00:00:00.000Z';
  await add('duplicate-a',['quartz orbit '.repeat(9)],{originKey,createdAt});
  await add('duplicate-z',['quartz orbit corpus distinct words'],{originKey,createdAt});
  await kernelPool().query('DELETE FROM document_text_chunks WHERE version_id=(SELECT current_version_id FROM document_texts WHERE id=$1)',[main.id]);
  const compare=async(query:string,options:DocumentSearchOptions)=>{
    const {normalized,words}=documentSearchTerms(query),args:unknown[]=[owner,options.strict?normalized:words.join(' '),
      words.map(word=>`"${word}"`).join(' OR '),options.limit??14,words];
    const filters=[options.courseId?`AND d.course_id=$${args.push(options.courseId)}`:'',options.documentId?`AND d.id=$${args.push(options.documentId)}`:''].join(' ');
    let sql=legacy.replace('d.hidden=false','d.hidden=false '+filters);
    if(options.strict)sql=sql.replace('c.search_vector @@ q.broad','c.search_vector @@ q.exact');
    const expected=(await kernelPool().query(sql,args)).rows.map(row=>({...row,score:Number(row.score),lexical_support:Number(row.lexical_support),retrieval_mode:'keyword'}));
    const actual=await kernel.searchDocumentText(owner,query,{semantic:false,hybrid:false,aiRerank:false,relatedDocuments:false,...options});
    assert.deepEqual(actual,expected,'original IDs, exact floating scores/support, body and order must agree');
    assert.ok(actual.every(hit=>hit.document_id!==hidden.id&&!hit.body.includes('obsolete')&&!hit.document_id.endsWith('duplicate-a')));
    return actual;
  };
  for(const options of [{limit:2},{limit:14},{strict:true,limit:14},{courseId:course,limit:14},
    {documentId:main.id,limit:14},{courseId:'missing-course',limit:14}])await compare('quartz orbit',options);
  await compare('quartz \\deg orbit',{limit:14});
  assert.equal((await compare('quartz orbit',{documentId:main.id,limit:1}))[0].body,'quartz quartz quartz orbit','missing snippet falls back to the original page body');
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
