import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PDFDocument} from 'pdf-lib';
import { kernel, parseDeadline } from '../lib/kernel/service.ts';
import { kernelPool, kernelTransaction, migrateKernel } from '../lib/kernel/db.ts';
import { claimIngestionJob, completeSourcePage, finishIngestionJob, queueIngestionJob } from '../lib/kernel/jobs.ts';
import {writeFile} from 'node:fs/promises';
import {preparePdfVisualEvidence} from '../lib/kernel/pdf-visual-evidence.ts';
import {DocumentContextError} from '../lib/kernel/document-context.ts';
import {sourcePageRegionsFixture,fixtureSha} from './fixtures/source-page-regions.ts';

test('registered orig recall hints update only page search, survive rebuild and reject stale/raw failure atomically',async()=>{
  await migrateKernel();
  const directory=mkdtempSync(join(tmpdir(),'kernel-orig-search-')),oldRoot=process.env.LIBRARY_DIR,oldHybrid=process.env.KERNEL_DOCUMENT_HYBRID,
    oldFetch=globalThis.fetch,tag=randomUUID(),owner=`orig-search:${tag}`,id=`orig-search-doc:${tag}`,title=`Synthetic Orig ${tag}`;
  process.env.LIBRARY_DIR=directory;process.env.KERNEL_DOCUMENT_HYBRID='false';let calls=0;
  globalThis.fetch=async()=>{calls++;throw Error('Orig recall fixture forbids providers');};
  try{
    const {documentSearchText}=await import('../lib/kernel/document-search.ts');
    const pdf=await PDFDocument.create();pdf.addPage([100,200]);const bytes=await pdf.save(),sourceHash=fixtureSha(bytes);
    const fixture=sourcePageRegionsFixture({documentId:id,currentVersionId:'unregistered',sourceVersionId:'unregistered',sourceHash,courseId:''},owner,
      {sourceHash,inputHash:sourceHash});
    // Registered synthetic raw declares text intentionally absent from the
    // stored body. This is an index engineering test, not PDF recognition.
    const needle='unseenorigneedle'+tag.replace(/[^a-z]/g,''),result=structuredClone(fixture.result);
    result.document.json_content.texts[1].orig=needle;
    const raw=Buffer.from(JSON.stringify({identity:fixture.identity,result})),rawHash=fixtureSha(raw),
      progress={...fixture.progress,batches:[{...fixture.progress.batches[0],resultHash:rawHash,taskId:'first-conversion-attempt'}]},
      layout={...fixture.layout,resultReferences:[{...fixture.reference,resultBlobSha256:rawHash}]};
    await writeFile(join(directory,sourceHash),bytes);await writeFile(join(directory,rawHash),raw);await writeFile(join(directory,fixture.pngSha),fixture.png);
    const visuals=await preparePdfVisualEvidence({owner,documentId:id,sourceHash,pdfBytes:bytes,layout},async()=>fixture.png);
    const document={id,ownerId:owner,courseId:'',name:title,hash:sourceHash,mime:'application/pdf',origin:'orig-fixture',originKey:id};
    const pages=[{pageNumber:1,locator:'page:1',text:fixture.body}],options={parserVersion:'synthetic-orig-v1',batchProvenance:progress,pdfVisuals:visuals,
      warnings:['Synthetic parser warning preserved'],evidenceConfidence:.5};
    await kernel.ingestParsedDocument(document,pages,options);
    const resolution=await kernel.resolveDocumentSource(owner,{selectedDocumentTitle:title});
    assert.equal(resolution.status,'resolved');if(resolution.status!=='resolved')throw Error('Synthetic orig source unresolved');
    const source=resolution.document,search=()=>kernel.searchDocumentText(owner,needle,{documentId:id,strict:true,semantic:false,aiRerank:false,hybrid:false,
      relatedDocuments:false,evidenceBody:'full-page'});
    const automatic=await search();assert.equal(automatic.length,1);assert.equal(automatic[0].body,fixture.body);
    assert.equal(automatic[0].retrieval_hint?.authority,'unverified-retrieval-hint');
    const immutable=async()=>(await kernelPool().query(`SELECT d.current_version_id,v.source_version_id,p.body,p.evidence_id,v.warnings,
      e.parsed_value,e.confidence,pv.manifest,pv.manifest_sha256,s.raw_value source_raw,s.raw_sha256 source_raw_sha256,
      (SELECT count(*)::int FROM document_page_embeddings WHERE version_id=v.id) vectors
      FROM document_texts d JOIN document_text_versions v ON v.id=d.current_version_id JOIN document_text_pages p ON p.version_id=v.id
      JOIN evidence e ON e.id=p.evidence_id JOIN source_item_versions s ON s.id=v.source_version_id
      JOIN document_pdf_visual_manifests pv ON pv.version_id=v.id WHERE d.owner_id=$1 AND d.id=$2`,[owner,id])).rows;
    const original=await immutable(),index=async()=>(await kernelPool().query(`SELECT p.search_text,p.search_hint_provenance,
      (SELECT jsonb_agg(jsonb_build_array(c.id,c.body,c.search_text) ORDER BY c.position) FROM document_text_chunks c WHERE c.version_id=p.version_id) chunks
      FROM document_text_pages p WHERE p.version_id=$1 AND p.page_number=1`,[source.currentVersionId])).rows[0];
    // Only this new fixture is reset to simulate an older body-only index.
    await kernelPool().query('UPDATE document_text_pages SET search_text=$2,search_hint_provenance=NULL WHERE version_id=$1',
      [source.currentVersionId,documentSearchText(fixture.body)]);
    assert.equal((await search()).length,0);
    assert.equal((await kernel.refreshDocumentOrigSearchHints(owner,source,1)).status,'updated');
    const recalled=await search();assert.equal(recalled.length,1);assert.equal(recalled[0].evidence_id,automatic[0].evidence_id);
    assert.equal(recalled[0].body.includes(needle),false);assert.equal(recalled[0].retrieval_hint?.visibilityVerified,false);
    assert.deepEqual(recalled[0].retrieval_hint?.rawResults.map(r=>r.resultBlobSha256),[rawHash]);
    const published=await index();assert.equal((await kernel.refreshDocumentOrigSearchHints(owner,source,1)).status,'unchanged');
    await kernel.rebuildDocumentSearch(owner,id);assert.deepEqual(await index(),published);assert.deepEqual(await immutable(),original);
    // Same immutable source replay must not append the old hint again.
    await kernel.ingestParsedDocument(document,pages,options);assert.deepEqual(await index(),published);
    // Only the runtime conversion ID changes. The immutable version and its
    // original stored source raw remain exactly as first published.
    await kernel.ingestParsedDocument(document,pages,{...options,batchProvenance:{...progress,
      batches:[{...progress.batches[0],taskId:'second-conversion-attempt'}]}});
    assert.deepEqual(await index(),published);assert.deepEqual(await immutable(),original);
    assert.equal(original[0].source_raw.batchProvenance.batches[0].taskId,'first-conversion-attempt');
    await assert.rejects(kernel.refreshDocumentOrigSearchHints('foreign',source,1));
    await assert.rejects(kernel.refreshDocumentOrigSearchHints(owner,{...source,currentVersionId:'stale'},1));
    assert.deepEqual(await index(),published);
    await writeFile(join(directory,rawHash),'broken CAS');
    await assert.rejects(kernel.refreshDocumentOrigSearchHints(owner,source,1),/checksum/);
    await assert.rejects(kernel.rebuildDocumentSearch(owner,id),/checksum/);
    assert.deepEqual(await index(),published);assert.deepEqual(await immutable(),original);
    await writeFile(join(directory,rawHash),raw);
    // An unavailable optional hint cannot discard normal valid PDF/body
    // ingestion. Its reason is returned separately from immutable warnings.
    const missingId=id+'-missing',missingIdentity={...fixture.identity,documentId:missingId},
      missingRawHash=fixtureSha(JSON.stringify({identity:missingIdentity,result})),
      missingProgress={...progress,identity:{...progress.identity,documentId:missingId},
        batches:[{...progress.batches[0],resultHash:missingRawHash}]};
    const missingVisuals=await preparePdfVisualEvidence({owner,documentId:missingId,sourceHash,pdfBytes:bytes,
      layout:{...fixture.layout,resultReferences:[]}},async()=>fixture.png);
    const degraded=await kernel.ingestParsedDocument({...document,id:missingId,name:title+' missing raw',originKey:missingId},pages,
      {parserVersion:'synthetic-orig-v1',batchProvenance:missingProgress,pdfVisuals:missingVisuals,warnings:options.warnings,evidenceConfidence:.5});
    assert.equal(degraded?.origSearchHints.pages[0].code,'unavailable');
    const persisted=(await kernelPool().query(`SELECT p.body,p.search_text,p.search_hint_provenance,v.warnings FROM document_texts d
      JOIN document_text_versions v ON v.id=d.current_version_id JOIN document_text_pages p ON p.version_id=v.id WHERE d.owner_id=$1 AND d.id=$2`,
      [owner,missingId])).rows[0];
    assert.equal(persisted.body,fixture.body);assert.equal(persisted.search_text,documentSearchText(fixture.body));
    assert.equal(persisted.search_hint_provenance,null);assert.deepEqual(persisted.warnings,options.warnings);assert.equal(calls,0);
  }finally{
    globalThis.fetch=oldFetch;if(oldRoot===undefined)delete process.env.LIBRARY_DIR;else process.env.LIBRARY_DIR=oldRoot;
    if(oldHybrid===undefined)delete process.env.KERNEL_DOCUMENT_HYBRID;else process.env.KERNEL_DOCUMENT_HYBRID=oldHybrid;
    rmSync(directory,{recursive:true,force:true});
  }
});

test('author-image table registration reaches natural title FTS, real selector/generator input and rejects foreign/current/row bindings',async()=>{
  await migrateKernel();
  const {hash,png,syntheticRun}=await import('./fixtures/author-image-table-v1/run.ts');
  const {nativeTableBlobHashes}=await import('../lib/kernel/document-table-candidates.ts');
  const {documentSearchText}=await import('../lib/kernel/document-search.ts');
  const {validateAndSerialize}=await import('../lib/kernel/visible-table-grid-v1.mjs');
  const tag=randomUUID(),owner=`author-grid-owner-${tag}`,id=`author-grid-${tag}`,title=`Author Grid Fixture ${tag}`;
  const doc={id,ownerId:owner,courseId:'',name:title,hash:hash(tag),mime:'application/json',origin:'author-grid-fixture',originKey:id};
  const text='Original author caption. The numeric contents exist only in the original image.';
  await kernel.ingestParsedDocument(doc,[{locator:'caption:0',text}],{parserVersion:'author-grid-fixture'});
  const resolved=await kernel.resolveDocumentSource(owner,{selectedDocumentTitle:title});
  assert.equal(resolved.status,'resolved');if(resolved.status!=='resolved')throw new Error('fixture source');
  const source=resolved.document,pages=await kernel.readDocumentSourcePages(owner,source),caption=pages.nodes[0].evidenceId;
  await kernel.registerDocumentStructure(owner,source,{rawSourceHash:doc.hash,parserVersion:'author-grid-fixture',parents:[],
    nodes:[{evidenceId:caption,locator:'caption:0',ordinal:0,kind:'caption',bodySha256:hash(text)}]});
  await kernel.registerDocumentImage(owner,source,{captionEvidenceId:caption,originalReference:'original.png',bytes:png,
    provenance:{sourceUrl:'https://example.invalid/public-fixture',revision:'synthetic-not-recognition'}});
  const [image]=await kernel.readDocumentImages(owner,source,[caption]),outline=await kernel.readDocumentOutline(owner,source);
  const run=await syntheticRun(image,outline.manifestSha256),item=await kernel.registerAuthorImageTableCandidate(owner,source,run);
  assert.deepEqual(await kernel.registerAuthorImageTableCandidate(owner,source,run),item,'same immutable run is idempotent');
  const hits=await kernel.searchAuthorImageTableCandidates(owner,'NeedleMeasure',source);assert.deepEqual(hits,[item]);
  const textOnly=await (kernel as any).studyAnswerContextReader(owner,'NeedleMeasure',{sourceHint:{selectedDocumentTitle:title},
    limit:14,semantic:false,hybrid:false,aiRerank:false,relatedDocuments:false,includeParents:false,includeImages:false});
  assert.deepEqual((await textOnly()).images,[],'an explicit title never bypasses the existing no-image switch');
  const noDerived=await (kernel as any).studyAnswerContextReader(owner,'NeedleMeasure',{sourceHint:{selectedDocumentTitle:title},
    limit:14,semantic:false,hybrid:false,aiRerank:false,relatedDocuments:false,includeParents:true,includeImages:true},false);
  assert.deepEqual((await noDerived()).images,[],'the existing derived-table opt-out also disables author observations');
  const evidence=await kernel.readAuthorImageTableCandidateEvidence(owner,hits);
  assert.equal(evidence.images[0].tableObservations?.[0].status,'available');assert.equal(evidence.images[0].sha256,hash(png));
  const stored=(await kernelPool().query('SELECT * FROM document_table_candidates WHERE id=$1',[item.id])).rows[0];
  assert.equal(stored.source_kind,'author-caption-image');assert.equal(stored.page_number,null);assert.equal(stored.manifest_sha256,null);
  assert.equal(stored.options_sha256,null);assert.equal(stored.attachment_id,image.attachmentId);
  assert.equal(stored.search_text,documentSearchText(validateAndSerialize(stored.artifact.grid).searchText));
  const requestBodies:any[]=[],originalFetch=globalThis.fetch,originalBypass=process.env.AI_BUDGET_TEST_BYPASS;
  process.env.AI_BUDGET_TEST_BYPASS='true';
  try{
    globalThis.fetch=async(_url,init)=>{
      const request=JSON.parse(String(init?.body));requestBodies.push(request);
      const payload=requestBodies.length===1?{referenceIds:['i0']}:{status:'answered',message:'',claims:[{text:'Synthetic test claim.',citations:[{id:'i0'}]}]};
      if(requestBodies.length>2)throw new Error('Unexpected synthetic provider attempt');
      return Response.json({status:'completed',model:'gpt-5.4-mini-2026-03-17',output_text:JSON.stringify(payload),usage:{input_tokens:1,output_tokens:1}});
    };
    const question=`What does NeedleMeasure report in "${title}"?`;
    await kernel.answerStudyContent(owner,question,{limit:14,semantic:false,hybrid:false,aiRerank:false,relatedDocuments:false,
      includeImages:true,includeParents:true},{scope:'application',model:'gpt-5.4-mini',maxOutputTokens:3000,evidenceSelection:'select-then-answer'});
    assert.equal(requestBodies.length,2);
    assert.equal(requestBodies[0].text.format.name,'document_evidence_selection');
    for(const body of requestBodies){
      const wire=JSON.stringify(body);assert.ok(wire.includes('author-image-table-observation-v1'));assert.ok(wire.includes('NeedleMeasure'));
      assert.ok(wire.includes('"semanticVerified":false')||wire.includes('\\"semanticVerified\\":false'));
      assert.equal(body.input.flatMap((x:any)=>Array.isArray(x.content)?x.content:[]).filter((x:any)=>x.type==='input_image').length,1);
    }
  }finally{globalThis.fetch=originalFetch;if(originalBypass===undefined)delete process.env.AI_BUDGET_TEST_BYPASS;else process.env.AI_BUDGET_TEST_BYPASS=originalBypass;}
  await assert.rejects(kernel.readAuthorImageTableCandidateEvidence('foreign-owner',hits));
  await assert.rejects(kernel.registerAuthorImageTableCandidate('foreign-owner',source,run));
  await kernelPool().query('UPDATE document_table_candidates SET input_sha256=$2 WHERE id=$1',[item.id,hash('foreign request')]);
  await assert.rejects(kernel.readAuthorImageTableCandidateEvidence(owner,hits));
  await kernelPool().query('UPDATE document_table_candidates SET input_sha256=$2 WHERE id=$1',[item.id,stored.input_sha256]);
  await kernel.ingestParsedDocument(doc,[{locator:'caption:0',text:'Changed current source'}],{parserVersion:'author-grid-fixture-new'});
  await assert.rejects(kernel.readAuthorImageTableCandidateEvidence(owner,hits));
  const refs=await nativeTableBlobHashes(kernelPool());
  for(const ref of stored.artifact.blobReferences)assert.ok(refs.includes(ref.sha256),'historical original protocol bytes remain GC roots');
});

test('deadline precision never fabricates a time',()=>{
  assert.deepEqual(parseDeadline('2026-09-25'),{date:'2026-09-25',at:null,localTime:null,timezone:null,precision:'date',original:'2026-09-25'});
  assert.equal(parseDeadline('2026-09-25T12:30').precision,null);
  assert.equal(parseDeadline('2026-02-30').precision,null);
  assert.equal(parseDeadline('2026-09-25T23:59:00-04:00').precision,null);
  assert.equal(parseDeadline('2026-09-25T23:59:00Z','America/Toronto').localTime,'19:59:00');
  assert.equal(parseDeadline('2026-09-25T12:30:00Z').timezone,'Etc/UTC');
  assert.deepEqual(parseDeadline('2026-09-25T23:59:00-04:00','America/Toronto'),{
    date:'2026-09-25',at:'2026-09-26T03:59:00.000Z',localTime:'23:59:00',
    timezone:'America/Toronto',precision:'second',original:'2026-09-25T23:59:00-04:00'});
  assert.equal(parseDeadline('2026-09-25T23:59:00-05:00','America/Toronto').precision,null);
});

test('typed Canvas planner and assignment resolve to one task in either arrival order',async()=>{
  await migrateKernel();
  for(const plannerFirst of [true,false]){
    const courseId=`canvas-pair:${randomUUID()}`;
    await kernel.upsertCourse({id:courseId,name:'Canvas pair',course_code:'PAIR'});
    const assignment={id:`${courseId}:assignment:42`,courseId,sourceType:'assignment',sourceId:'42',
      title:'Problem set',body:'Submit answers',sourceUrl:`https://canvas.example/courses/${courseId}/assignments/42`,
      updatedAt:'2026-09-21T12:00:00Z',dueAt:'2026-10-01',unlockAt:null,lockAt:null};
    const planner={...assignment,id:`${courseId}:planner:900`,sourceType:'planner',sourceId:'900',
      sourceUrl:null,plannableType:'assignment',plannableId:'42',body:'Planner summary'};
    const ordered=plannerFirst?[planner,assignment]:[assignment,planner];
    for(const item of ordered)await kernel.ingestCanvasSource(item,null,`${item.sourceType}-hash`);
    for(const item of ordered)await kernel.ingestCanvasSource(item,null,`${item.sourceType}-hash`);
    const tasks=await kernel.taskRows(courseId);
    assert.equal(tasks.length,1);
    assert.equal(tasks[0].source_type,'assignment');
    assert.equal(tasks[0].source_item_id,assignment.id);
    const versions=(await kernelPool().query<{source_item_id:string}>(
      'SELECT source_item_id FROM source_item_versions WHERE source_item_id=ANY($1::text[])',
      [[planner.id,assignment.id]])).rows;
    assert.deepEqual(new Set(versions.map(row=>row.source_item_id)),new Set([planner.id,assignment.id]));
    assert.equal(versions.length,2);
    const dueEvidence=(await kernel.canonicalEvidence([], [tasks[0].id], []))
      .filter(row=>row.attribute==='due');
    assert.deepEqual(new Set(dueEvidence.map(row=>row.source_item_id)),new Set([planner.id,assignment.id]));
    await kernel.ingestCanvasSource({...assignment,id:`${courseId}:quiz:42`,sourceType:'quiz',
      sourceUrl:null},null,'quiz-hash');
    assert.equal((await kernel.taskRows(courseId)).length,2);
  }
});

test('extra AI actions from one planner item cannot map onto assignment action zero',async()=>{
  await migrateKernel();
  const courseId=`canvas-actions:${randomUUID()}`;
  await kernel.upsertCourse({id:courseId,name:'Canvas actions',course_code:'ACT'});
  const assignment={id:`${courseId}:assignment:42`,courseId,sourceType:'assignment',sourceId:'42',
    title:'Lab',body:'Submit lab',sourceUrl:null,updatedAt:null,dueAt:null,unlockAt:null,lockAt:null};
  await kernel.ingestCanvasSource(assignment,null,'assignment');
  const planner={...assignment,id:`${courseId}:planner:900`,sourceType:'planner',sourceId:'900',
    plannableType:'assignment',plannableId:'42'};
  const action=(title:string)=>({title,action:`Do ${title}`,requirements:[],recommendedStartAt:null,
    inferredDueAt:null,confidence:'inferred' as const,evidence:title,estimatedMinutes:null,possiblyCancelled:false});
  await kernel.ingestCanvasSource(planner,{summary:'',actions:[action('Part A'),action('Part B')],notes:[]},'planner');
  const task=(await kernel.taskRows(courseId))[0];
  const rows=(await kernelPool().query<{entity_id:string;locator:string}>(
    `SELECT c.entity_id,e.locator FROM candidate_facts c JOIN evidence e ON e.id=c.evidence_id
     WHERE e.source_item_id=$1 AND c.attribute='task_payload' ORDER BY e.locator`,[planner.id])).rows;
  assert.equal(rows.length,2);
  assert.equal(rows[0].entity_id,task.entity_id);
  assert.notEqual(rows[1].entity_id,task.entity_id);
  assert.equal((await kernel.taskRows(courseId)).length,1);
});

test('reviewed Canvas reconciliation retains source history and local status, and can be undone',async()=>{
  await migrateKernel();
  const courseId=`canvas-merge:${randomUUID()}`;
  await kernel.upsertCourse({id:courseId,name:'Canvas merge',course_code:'MERGE'});
  const base={course_id:courseId,title:'Same title',action:'Complete task',requirements_json:'[]',
    start_at:null,due_at:'2026-10-01',unlock_at:null,lock_at:null,canvas_status:'upcoming',
    urgency:'upcoming',confidence:'certain',evidence:'legacy evidence',estimated_minutes:null,
    points_possible:null,prerequisite_blocked:0,updated_at:'2026-09-20T12:00:00Z'};
  const plannerId=`${courseId}:planner:42:0`,assignmentId=`${courseId}:assignment:42:0`;
  await kernel.importLegacyTask({...base,id:plannerId,source_item_id:`${courseId}:planner:42`,
    source_type:'planner',source_id:'42',source_url:null},'completed');
  await kernel.importLegacyTask({...base,id:assignmentId,source_item_id:`${courseId}:assignment:42`,
    source_type:'assignment',source_id:'42',
    source_url:`https://canvas.example/courses/${courseId}/assignments/42`});
  const assignment={id:`${courseId}:assignment:42`,courseId,sourceType:'assignment',sourceId:'42',
    title:'Same title',body:'Current assignment',sourceUrl:`https://canvas.example/courses/${courseId}/assignments/42`,
    updatedAt:'2026-09-21T12:00:00Z',dueAt:'2026-10-01',unlockAt:null,lockAt:null};
  await kernel.ingestCanvasSource(assignment,null,'current-assignment');
  await kernel.ingestCanvasSource({...assignment,id:`${courseId}:planner:42`,sourceType:'planner',
    sourceUrl:null,plannableType:'assignment',plannableId:'42'},null,'current-planner');
  const report=await kernel.canvasDuplicateReport();
  assert.ok(report.verified.some(pair=>pair.plannerTaskId===plannerId&&pair.directTaskId===assignmentId));
  const before=report.activeCount;
  const plannerEntity=(await kernel.taskRows(courseId,true)).find(task=>task.id===plannerId)?.entity_id;
  const merged=await kernel.mergeCanvasTasks(plannerId,assignmentId,'verified assignment:42','test-admin');
  assert.equal(merged.activeCount,before-1);
  const tasks=await kernel.taskRows(courseId,true);
  assert.equal(tasks.length,1);
  assert.equal(tasks[0].local_status,'completed');
  assert.equal((await kernel.taskTarget(plannerId))?.source_type,'assignment');
  assert.ok((await kernel.canonicalEvidence([], [assignmentId], []))
    .some(row=>row.attribute==='due'&&row.source_item_id===`${courseId}:planner:42`));
  assert.ok(Number((await kernelPool().query(
    `SELECT count(*) FROM fact_versions WHERE fact_id=(SELECT id FROM facts WHERE entity_id=$1
     AND attribute='due')`,[plannerEntity])).rows[0].count)>0);
  await kernel.rebuildProjections();
  assert.equal((await kernel.taskRows(courseId,true)).length,1);
  const restored=await kernel.unmergeCanvasTasks(plannerId,'reviewed rollback','test-admin');
  assert.equal(restored.activeCount,before);
  assert.equal((await kernel.taskRows(courseId,true)).length,2);
  assert.equal((await kernel.taskRows(courseId,true)).find(task=>task.id===plannerId)?.local_status,'completed');
  assert.equal((await kernel.taskRows(courseId,true)).find(task=>task.id===assignmentId)?.local_status,'active');
  const audit=(await kernelPool().query<{actor:string;rolled_back_by:string;rollback_reason:string;
    before_value:{activeCount:number};after_value:{activeCount:number};
    rollback_before_value:{activeCount:number};rollback_after_value:{activeCount:number}}>(
    'SELECT * FROM task_entity_merges WHERE source_task_id=$1 ORDER BY applied_at DESC LIMIT 1',
    [plannerId])).rows[0];
  assert.equal(audit.actor,'test-admin');
  assert.equal(audit.rolled_back_by,'test-admin');
  assert.equal(audit.rollback_reason,'reviewed rollback');
  assert.equal(audit.after_value.activeCount,audit.before_value.activeCount-1);
  assert.equal(audit.rollback_after_value.activeCount,audit.rollback_before_value.activeCount+1);
  assert.ok(!(await kernel.canonicalEvidence([], [assignmentId], []))
    .some(row=>row.attribute==='due'&&row.source==='legacy_import'&&
      row.source_item_id===`${courseId}:planner:42`));
  await kernel.ingestCanvasSource({...assignment,id:`${courseId}:planner:42`,sourceType:'planner',
    sourceUrl:null,plannableType:'assignment',plannableId:'42',body:'Planner resynced'},null,'after-rollback');
  await kernel.ingestCanvasSource(assignment,null,'current-assignment');
  assert.equal((await kernel.taskRows(courseId,true)).length,2);
  assert.ok(!(await kernel.canvasDuplicateReport()).verified.some(pair=>pair.plannerTaskId===plannerId));
});

test('rollback removes a fact created only by reconciliation',async()=>{
  await migrateKernel();
  const courseId=`canvas-undo:${randomUUID()}`;
  await kernel.upsertCourse({id:courseId,name:'Canvas undo',course_code:'UNDO'});
  const base={course_id:courseId,title:'Quiz review',action:'Review quiz',requirements_json:'[]',
    start_at:null,unlock_at:null,lock_at:null,canvas_status:'upcoming',urgency:'upcoming',
    confidence:'certain',evidence:'legacy',estimated_minutes:null,points_possible:null,
    prerequisite_blocked:0,updated_at:'2026-09-20T12:00:00Z'};
  const plannerId=`${courseId}:planner:42:0`,directId=`${courseId}:assignment:42:0`;
  await kernel.importLegacyTask({...base,id:plannerId,source_item_id:`${courseId}:planner:42`,
    source_type:'planner',source_id:'42',source_url:null,due_at:'2026-10-01'});
  await kernel.importLegacyTask({...base,id:directId,source_item_id:`${courseId}:assignment:42`,
    source_type:'assignment',source_id:'42',source_url:null,due_at:null});
  await kernel.ingestCanvasSource({id:`${courseId}:planner:42`,courseId,sourceType:'planner',
    sourceId:'42',plannableType:'assignment',plannableId:'42',title:'Quiz review',body:'',
    sourceUrl:null,updatedAt:null,dueAt:null,unlockAt:null,lockAt:null},null,'typed-reference');
  await kernel.mergeCanvasTasks(plannerId,directId,'verified assignment reference','test-admin');
  assert.equal((await kernel.taskRows(courseId,true)).find(task=>task.id===directId)?.due_date,'2026-10-01');
  assert.equal((await kernelPool().query('SELECT due_at FROM tasks WHERE id=$1',[directId])).rows[0].due_at,null);
  await kernel.unmergeCanvasTasks(plannerId,'undo derived due date','test-admin');
  const tasks=await kernel.taskRows(courseId,true);
  assert.equal(tasks.find(task=>task.id===directId)?.due_date,null);
  assert.equal(tasks.find(task=>task.id===plannerId)?.due_date,'2026-10-01');
});

test('AI extraction remains reviewable and cannot replace a Canvas assignment',async()=>{
  await migrateKernel();
  const courseId=`ai-review:${randomUUID()}`;
  await kernel.upsertCourse({id:courseId,name:'AI review',course_code:'AIR101'});
  const source={id:`${courseId}:assignment:1`,courseId,sourceType:'assignment',sourceId:'1',
    title:'Original assignment',body:'Submit the original assignment',sourceUrl:null,
    updatedAt:'2026-09-20T12:00:00Z',dueAt:'2026-09-25',unlockAt:null,lockAt:null};
  const analysis={summary:'AI suggestion',actions:[{title:'Renamed by AI',action:'Add invented steps',
    requirements:['Invented requirement'],recommendedStartAt:'2026-09-22T09:00:00Z',
    inferredDueAt:'2026-09-24',confidence:'certain' as const,evidence:'AI interpretation',
    estimatedMinutes:30,possiblyCancelled:true}],notes:[]};
  await kernel.ingestCanvasSource(source,analysis,'original-hash');
  const task=(await kernel.taskRows(courseId))[0];
  assert.equal(task.title,'Original assignment');
  assert.equal(task.due_at,'2026-09-25');
  assert.equal(task.cancelled_at,null);
  assert.deepEqual(task.requirements,[]);
  const pending=(await kernel.pendingCandidates()).filter(row=>row.entity_id===task.entity_id);
  assert.ok(pending.some(row=>row.attribute==='task_payload'&&row.authority==='ai'));
  assert.ok(pending.some(row=>row.attribute==='due'&&row.authority==='ai'));
  const evidence=await kernel.canonicalEvidence([courseId],[task.id],[]);
  assert.ok(evidence.some(row=>row.entity_kind==='task'&&row.attribute==='task_payload'&&row.source==='canvas'));
  assert.ok(evidence.some(row=>row.entity_kind==='task'&&row.attribute==='due'&&row.source==='canvas'));
  assert.ok(!evidence.some(row=>row.authority==='ai'));
  await kernel.setTaskStatus(task.id,'ignored');
  assert.ok(!(await kernel.taskRows(courseId)).some(row=>row.id===task.id));
  assert.ok((await kernel.taskRows(courseId,true)).some(row=>row.id===task.id&&row.local_status==='ignored'));
});

test('kernel ingestion is idempotent, tracks source absence, resolves newer Canvas evidence and reviews cancellation',async()=>{
  await migrateKernel();
  const courseId=`test:${randomUUID()}`,sourceId=`${courseId}:assignment:42`;
  await kernel.upsertCourse({id:courseId,name:'Math',course_code:'MAT101',updated_at:'2026-09-20T12:00:00Z'});
  await kernel.upsertCourse({id:courseId,name:'Math revised',course_code:'MAT101'});
  assert.equal((await kernel.getCourse(courseId))?.name,'Math revised');
  const source={id:sourceId,courseId,sourceType:'assignment',sourceId:'42',title:'Tutorial 2',body:'Submit Tutorial 2',
    sourceUrl:`https://canvas.example/courses/${courseId}/assignments/42`,updatedAt:'2026-09-20T12:00:00Z',
    dueAt:'2026-09-25T23:59:00Z',unlockAt:null,lockAt:null};
  await kernel.ingestCanvasSource(source,null,'hash-1');
  await kernel.ingestCanvasSource(source,null,'hash-1');
  let tasks=await kernel.taskRows(courseId);
  assert.equal(tasks.length,1);
  assert.equal(tasks[0].due_at,'2026-09-25T23:59:00.000Z');
  assert.equal(Number((await kernelPool().query('SELECT count(*) FROM source_item_versions WHERE source_item_id=$1',[sourceId])).rows[0].count),1);
  const windowedId=`${courseId}:announcement:old`;
  await kernel.ingestCanvasSource({...source,id:windowedId,sourceType:'announcement',sourceId:'old',
    dueAt:null,title:'Old announcement'},null,'windowed-hash');
  assert.equal(await kernel.completeSourceScan('canvas',courseId,[],null,'2026-09-20T00:00:00Z'),0);
  assert.equal((await kernel.taskRows(courseId))[0].source_missing,false);
  await kernel.completeSourceScan('canvas',courseId,[],null,'2100-01-01T00:00:00Z');
  assert.equal((await kernelPool().query('SELECT state FROM source_items WHERE id=$1',[windowedId])).rows[0].state,'active');
  tasks=await kernel.taskRows(courseId);
  assert.equal(tasks[0].source_missing,true);
  assert.equal(tasks[0].due_at,'2026-09-25T23:59:00.000Z');
  await kernel.ingestCanvasSource({...source,body:'Tutorial 2 postponed; new deadline below',updatedAt:'2026-09-21T12:00:00Z',dueAt:'2026-09-30T23:59:00Z'},null,'hash-2');
  tasks=await kernel.taskRows(courseId);
  assert.equal(tasks[0].source_missing,false);
  assert.equal(tasks[0].due_at,'2026-09-30T23:59:00.000Z');
  assert.equal(tasks[0].cancelled_at,null);
  const currentDueEvidence=(await kernel.canonicalEvidence([], [tasks[0].id], []))
    .filter(row=>row.attribute==='due');
  assert.ok(currentDueEvidence.some(row=>row.original_excerpt==='2026-09-30T23:59:00Z'));
  assert.ok(!currentDueEvidence.some(row=>row.original_excerpt==='2026-09-25T23:59:00Z'));
  const emailId=`mail:${randomUUID()}`;
  await kernel.ingestMailAnalysis({id:emailId,account:'test@example.com',sender:'instructor@example.edu',
    subject:'Tutorial 2',body:'Tutorial 2 is cancelled',receivedAt:'2026-09-22T12:00:00Z',hash:randomUUID()},
    {deadlines:[],referencedUrls:[source.sourceUrl],actionItems:[{title:'Tutorial 2 cancelled',description:'No longer required',
      evidence:'Tutorial 2 is cancelled',confidence:0.99}]});
  const pending=(await kernel.pendingCandidates()).find(row=>row.attribute==='cancelled'&&row.entity_id===tasks[0].entity_id);
  assert.ok(pending);
  assert.equal((await kernel.taskRows(courseId))[0].cancelled_at,null);
  await kernel.adjudicate(pending.id,'accept','Confirmed against the instructor announcement','test-admin');
  assert.ok((await kernel.taskRows(courseId))[0].cancelled_at);
  const audit=(await kernelPool().query<{actor:string;before_value:unknown;after_value:unknown}>(
    'SELECT actor,before_value,after_value FROM adjudications WHERE candidate_id=$1',[pending.id])).rows[0];
  assert.equal(audit.actor,'test-admin');
  assert.equal(audit.before_value,null);
  assert.equal(audit.after_value,true);
  assert.equal(Number((await kernelPool().query(
    `SELECT count(*) FROM fact_versions WHERE fact_id=(SELECT id FROM facts WHERE entity_id=$1 AND attribute='due')`,
    [tasks[0].entity_id])).rows[0].count),2);
  const dueHistory=(await kernelPool().query<{valid_from:Date;valid_to:Date|null}>(
    `SELECT valid_from,valid_to FROM fact_versions WHERE fact_id=
     (SELECT id FROM facts WHERE entity_id=$1 AND attribute='due') ORDER BY version`,
    [tasks[0].entity_id])).rows;
  assert.equal(dueHistory[0].valid_from.toISOString(),'2026-09-20T12:00:00.000Z');
  assert.equal(dueHistory[0].valid_to?.toISOString(),'2026-09-21T12:00:00.000Z');
  assert.equal(dueHistory[1].valid_from.toISOString(),'2026-09-21T12:00:00.000Z');
  await kernel.completeSourceScan('canvas',courseId,[],null,'2100-01-01T00:00:00Z');
  const before=(await kernel.taskRows(courseId))[0];
  assert.equal(before.source_missing,true);
  await kernel.rebuildProjections();
  const rebuilt=(await kernel.taskRows(courseId))[0];
  assert.equal(rebuilt.source_missing,true);
  assert.equal(rebuilt.due_at,before.due_at);
  assert.equal(new Date(rebuilt.cancelled_at).toISOString(),new Date(before.cancelled_at).toISOString());
  await kernel.ingestMailAnalysis({id:`unlinked:${randomUUID()}`,account:'test@example.com',
    sender:'instructor@example.edu',subject:'Revised tutorial date',body:'Due October 15',
    receivedAt:'2026-09-23T12:00:00Z',hash:randomUUID()},
    {deadlines:[{at:'2026-10-15',text:'Due October 15',confidence:0.9,evidence:'Due October 15'}]});
  const unlinked=(await kernel.pendingCandidates()).find(row=>row.attribute==='due'&&row.entity_kind==='mail_claim');
  assert.ok(unlinked);
  await assert.rejects(kernel.adjudicate(unlinked.id,'accept','Verified message','test-admin'),/Link this claim/);
  const linkedId=await kernel.linkCandidate(unlinked.id,tasks[0].id,'Same assignment URL confirmed externally','test-admin');
  await kernel.adjudicate(linkedId,'accept','Date confirmed by instructor','test-admin');
  assert.equal((await kernel.taskRows(courseId))[0].due_at,'2026-10-15');
});

test('persistent jobs recover expired leases and failed transactions roll back',async()=>{
  await migrateKernel();
  const key=`test-job:${randomUUID()}`;
  const id=await queueIngestionJob('test','test','unit',{value:1},key);
  assert.equal(await queueIngestionJob('test','test','unit',{value:1},key),id);
  const claimed=await claimIngestionJob();
  assert.equal(claimed?.id,id);
  await kernelPool().query(`UPDATE ingestion_jobs SET lease_until=now()-interval '1 second' WHERE id=$1`,[id]);
  const reclaimed=await claimIngestionJob();
  assert.equal(reclaimed?.id,id);
  assert.notEqual(reclaimed?.lease_token,claimed?.lease_token);
  await finishIngestionJob(id,claimed!.lease_token);
  assert.equal((await kernelPool().query('SELECT state FROM ingestion_jobs WHERE id=$1',[id])).rows[0].state,'running');
  await finishIngestionJob(id,reclaimed!.lease_token,'retry');
  const row=(await kernelPool().query('SELECT state,attempts FROM ingestion_jobs WHERE id=$1',[id])).rows[0];
  assert.equal(row.state,'queued');
  assert.equal(row.attempts,2);
  await assert.rejects(completeSourcePage('test',key,'cursor',false));
  assert.equal((await kernelPool().query('SELECT cursor_value FROM source_status WHERE source=$1 AND scope=$2',['test',key])).rowCount,0);
  const marker=`rollback:${randomUUID()}`;
  await assert.rejects(kernelTransaction(async client=>{
    await client.query(`INSERT INTO academic_terms(id,name) VALUES ($1,'test')`,[marker]);
    throw new Error('abort');
  }));
  assert.equal(Number((await kernelPool().query('SELECT count(*) FROM academic_terms WHERE id=$1',[marker])).rows[0].count),0);
});

test('legacy core import preserves provenance, task status, date-only deadlines and events',async()=>{
  await migrateKernel();
  const suffix=randomUUID(),courseId=`legacy:${suffix}`,sourceItemId=`legacy-source:${suffix}`;
  await kernel.upsertCourse({id:courseId,name:'Legacy course',course_code:'LEG101'},'legacy_import');
  await kernel.upsertCourse({id:`disabled:${suffix}`,name:'Disabled legacy',code:'OFF101',enabled:0},'legacy_import');
  assert.equal((await kernel.getCourse(`disabled:${suffix}`))?.enabled,false);
  const row={id:`${sourceItemId}:0`,course_id:courseId,source_item_id:sourceItemId,
    source_type:'assignment',source_id:'old-42',source_url:null,title:'Old tutorial',
    action:'Submit old tutorial',requirements_json:'[]',start_at:null,due_at:'2026-10-05',
    unlock_at:null,lock_at:null,canvas_status:'upcoming',urgency:'upcoming',
    confidence:'certain',evidence:'legacy row',estimated_minutes:30,points_possible:10,
    prerequisite_blocked:0,updated_at:'2026-09-20T00:00:00Z'};
  await kernel.importLegacyTask(row,'completed');
  await kernel.importLegacyTask(row,'completed');
  await kernel.importLegacySource({id:sourceItemId,course_id:courseId,source_type:'assignment',
    source_id:'old-42',source_url:null,content_hash:'old-hash',remote_updated_at:null,
    is_active:0,missing_at:'2026-09-21T00:00:00Z'});
  const task=(await kernel.taskRows(courseId))[0];
  assert.equal(task.local_status,'completed');
  assert.equal(task.source_missing,true);
  assert.equal(task.due_at,'2026-10-05');
  assert.equal(task.due_precision,'date');
  assert.equal(task.due_timezone,null);
  assert.equal(Number((await kernelPool().query(
    `SELECT count(*) FROM evidence WHERE source='legacy_import' AND source_item_id=$1`,[sourceItemId])).rows[0].count),3);
  await kernel.ingestEvent('old-ics',{uid:`event-${suffix}`,title:'Old event',description:'Imported calendar row',
    startAt:'2026-10-01T12:00:00Z',endAt:'2026-10-01T13:00:00Z',allDay:false},'legacy_import');
  assert.equal((await kernel.listEvents('2026-10-01T00:00:00Z','2026-10-02T00:00:00Z')).some(
    event=>event.uid===`event-${suffix}`),true);
  await kernel.rebuildProjections();
  assert.equal((await kernel.taskRows(courseId))[0].source_missing,true);
  assert.equal((await kernel.taskRows(courseId))[0].local_status,'completed');
});

test('Docling failure keeps the original and retry commits parsed evidence',async()=>{
  await migrateKernel();
  const directory=mkdtempSync(join(tmpdir(),'kernel-docling-'));
  process.env.DATABASE_URL=':memory:';
  process.env.LIBRARY_DIR=directory;
  process.env.DOCLING_URL='http://docling.invalid';
  const library=await import('../lib/library.ts');
  const {convertDocumentWithDocling}=await import('../lib/kernel/docling.ts');
  const pdf=await PDFDocument.create();pdf.addPage().drawText('Recovered formula notes');
  const id=await library.saveDocument('owner','','upload','retry.pdf','retry.pdf','application/pdf',await pdf.save());
  const original=globalThis.fetch;
  try{
    globalThis.fetch=async()=>new Response('unavailable',{status:503});
    await assert.rejects(convertDocumentWithDocling('owner',id),/submit failed/);
    assert.equal(Number((await kernelPool().query('SELECT count(*) FROM source_items WHERE id=$1',[`document:${id}`])).rows[0].count),0);
    globalThis.fetch=async url=>String(url).endsWith('/async')
      ?Response.json({task_id:'retry-task',task_status:'success'})
      :Response.json({status:'success',document:{json_content:{pages:{'1':{page_no:1}},body:{children:[{$ref:'#/texts/0'}]},
        texts:[{text:'Recovered formula notes',prov:[{page_no:1}]}]}}});
    await convertDocumentWithDocling('owner',id);
    assert.equal(Number((await kernelPool().query('SELECT count(*) FROM evidence WHERE source_item_id=$1',[`document:${id}`])).rows[0].count),1);
    assert.equal((await library.getDocument('owner',id)).status,'ready');
  }finally{
    globalThis.fetch=original;
    rmSync(directory,{recursive:true,force:true});
  }
});

test('real PG current-page regions bind registered synthetic PDF and injected PNG without rewriting evidence',async()=>{
  await migrateKernel();
  const directory=mkdtempSync(join(tmpdir(),'kernel-source-regions-')),previousRoot=process.env.LIBRARY_DIR,
    previousFetch=globalThis.fetch,tag=randomUUID(),owner='regions-pg:'+tag,id='regions-pg-doc:'+tag,title='Synthetic regions '+tag;
  process.env.LIBRARY_DIR=directory;let calls=0;
  globalThis.fetch=async()=>{calls++;throw Error('Synthetic region integration has no external service');};
  try{
    const pdf=await PDFDocument.create();pdf.addPage([100,200]).drawText('Synthetic fixture',{x:5,y:100,size:6});
    const bytes=await pdf.save(),sourceHash=fixtureSha(bytes),fixture=sourcePageRegionsFixture({documentId:id,
      currentVersionId:'not-yet-registered',sourceVersionId:'not-yet-registered',sourceHash,courseId:''},owner,{sourceHash,inputHash:sourceHash});
    await writeFile(join(directory,sourceHash),bytes);
    for(const blob of fixture.casBlobs)await writeFile(join(directory,blob.sha256),blob.bytes);
    // This is an explicitly injected 1px test renderer, not PDF text recognition.
    const visuals=await preparePdfVisualEvidence({owner,documentId:id,sourceHash,pdfBytes:bytes,layout:fixture.layout},async()=>fixture.png);
    await kernel.ingestParsedDocument({id,ownerId:owner,courseId:'',name:title,hash:sourceHash,mime:'application/pdf',origin:'regions-pg-fixture',originKey:id},
      [{pageNumber:1,locator:'page:1',text:fixture.body}],{parserVersion:'synthetic-regions-fixture-v1',batchProvenance:fixture.progress,pdfVisuals:visuals});
    const resolved=await kernel.resolveDocumentSource(owner,{selectedDocumentTitle:title});
    assert.equal(resolved.status,'resolved');if(resolved.status!=='resolved')throw Error('Synthetic source not registered');
    const source=resolved.document,before=await kernel.readDocumentSourcePages(owner,source),
      result=await kernel.readDocumentPageRegions(owner,source,1);
    assert.equal(result.status,'available');if(result.status!=='available')throw Error('Synthetic regions unavailable');
    assert.equal(result.pageEvidenceId,before.nodes[0].evidenceId);assert.equal(result.pageBodySha256,fixtureSha(fixture.body));
    assert.equal(result.image.sha256,fixture.pngSha);assert.equal(result.index.result.resultBlobSha256,fixture.rawHash);
    assert.equal(result.index.nodes.length,7);assert.equal(result.index.semanticRelationsVerified,false);assert.equal(result.index.visibilityVerified,false);
    assert.deepEqual(await kernel.readDocumentSourcePages(owner,source),before);
    await assert.rejects(kernel.readDocumentPageRegions('foreign-owner',source,1),error=>
      error instanceof DocumentContextError&&error.code==='DOCUMENT_CONTEXT_CHANGED');
    assert.equal(calls,0);
  }finally{
    globalThis.fetch=previousFetch;if(previousRoot===undefined)delete process.env.LIBRARY_DIR;else process.env.LIBRARY_DIR=previousRoot;
    rmSync(directory,{recursive:true,force:true});
  }
});
