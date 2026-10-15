import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {PDFDocument} from 'pdf-lib';
import sharp from 'sharp';
import {createDocumentImageBudget,DOCUMENT_IMAGE_LIMITS} from '../lib/kernel/document-image-budget.ts';
import {prepareDocumentAnswer} from '../lib/kernel/document-answer.ts';
import {preparePdfVisualEvidence,readPdfVisualEvidence,PdfVisualEvidenceError} from '../lib/kernel/pdf-visual-evidence.ts';
import {decodeDoclingResult} from '../lib/kernel/docling-result.ts';
import {prepareNativeTableCandidates,readNativeTableCandidateEvidence} from '../lib/kernel/document-table-candidates.ts';
import {readDocumentNodes} from '../lib/kernel/document-nodes.ts';
import {saveBlob} from '../lib/library.ts';
import {kernel} from '../lib/kernel/service.ts';
import {kernelPool,migrateKernel} from '../lib/kernel/db.ts';
import type {DocumentContextSource} from '../lib/kernel/document-context.ts';
const sha=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const source={documentId:'doc',currentVersionId:'v',sourceVersionId:'s',sourceHash:'a'.repeat(64),courseId:''};
const image=(id:string,extra:Record<string,unknown>={})=>({attachmentId:id,source,anchorEvidenceId:id,sha256:sha(id),
 width:1932,height:2500,byteLength:100,...extra});

test('one deterministic budget retains rank, deduplicates same attachments and rejects conflicting duplicates',()=>{
 const budget=createDocumentImageBudget();
 for(let rank=1;rank<=14;rank++)budget.include(image('image-'+rank),rank);
 assert.deepEqual(budget.snapshot().included.map(item=>item.anchorRank),[1,2,3,4,5,6]);
 assert.equal(budget.snapshot().accounting.imageInputTokens,57834);
 assert.deepEqual(budget.snapshot().omitted.map(item=>[item.anchorRank,item.reason]),Array.from({length:8},(_,i)=>[i+7,'image-input-limit']));
 assert.equal(budget.include(image('image-1'),15),true);assert.equal(budget.snapshot().accounting.images,6);
 assert.throws(()=>budget.include(image('image-1',{sha256:sha('different')}),15),/Conflicting duplicate/);
 assert.equal(budget.include(image('small',{width:32,height:32,kind:'pdf-region'}),15),true);
 assert.equal(budget.snapshot().accounting.images,7,'small later genuine assets can still fit');
});

test('author, page and region images share count/byte/token limits and budget omissions enter input identity',()=>{
 for(const [limits,reason] of [[{...DOCUMENT_IMAGE_LIMITS,images:1},'image-count-limit'],
  [{...DOCUMENT_IMAGE_LIMITS,bytes:150},'image-byte-limit'],
  [{...DOCUMENT_IMAGE_LIMITS,imageInputTokens:10000},'image-input-limit']] as const){
  const budget=createDocumentImageBudget(limits);
  assert.equal(budget.include(image('author',{captionEvidenceId:'author',anchorEvidenceId:undefined}),1),true);
  assert.equal(budget.include(image('page',{kind:'pdf-page'}),2),false);
  assert.equal(budget.snapshot().omitted[0].reason,reason);
 }
 const budget=createDocumentImageBudget();for(let rank=1;rank<=7;rank++)budget.include(image('i'+rank),rank);
 const context={anchors:[],parents:[],images:[],sourceContentIsUntrusted:true as const};
 const plain=prepareDocumentAnswer('Inspect the mixed sources.',context),bounded=prepareDocumentAnswer('Inspect the mixed sources.',
  {...context,imageSelection:budget.snapshot()});
 assert.notEqual(plain.fingerprint,bounded.fingerprint);assert.deepEqual(bounded.input.imageSelection?.omitted,budget.snapshot().omitted);
 assert.throws(()=>createDocumentImageBudget({...DOCUMENT_IMAGE_LIMITS,images:65}),/Invalid ranked/);
});

let externalCalls=0;globalThis.fetch=async()=>{externalCalls++;throw new Error('Image composition forbids external calls');};
after(async()=>{assert.equal(externalCalls,0);if(process.env.KERNEL_DATABASE_URL)await kernelPool().end();});
const unavailable={status:'unavailable' as const,regions:[],pageSizes:[],reason:'Synthetic composition fixture has no layout'};

/** Blank PDFs, coloured PNGs and a fabricated native table are explicitly
 * synthetic plumbing fixtures. They assert composition, never OCR fidelity. */
async function pdfFixture(owner:string,count:number,withTable=false,small=false){
 const id='budget-'+randomUUID(),pdf=await PDFDocument.create();for(let i=0;i<count;i++)pdf.addPage([612,792]);
 const bytes=await pdf.save(),sourceHash=sha(bytes),pngs:Buffer[]=[];
 for(let i=0;i<count;i++)pngs.push(await sharp({create:{width:small?32:1932,height:small?32:2500,channels:3,
  background:{r:i+10,g:60,b:90}}}).png().toBuffer());
 let index=0;const visuals=await preparePdfVisualEvidence({owner,documentId:id,sourceHash,pdfBytes:bytes,layout:unavailable},async()=>pngs[index++]);
 let nativeTables;
 if(withTable){
  const raw={status:'success',document:{json_content:{pages:Object.fromEntries(Array.from({length:count},(_,i)=>[i+1,{page_no:i+1}])),
   body:{children:[{$ref:'#/tables/0'}]},tables:[{self_ref:'#/tables/0',prov:[{page_no:1}],captions:[],
    data:{num_rows:1,num_cols:1,table_cells:[{text:'budgettable',start_row_offset_idx:0,end_row_offset_idx:1,
     start_col_offset_idx:0,end_col_offset_idx:1,row_span:1,col_span:1}]}}],texts:[]}}};
  const copyIndices=Array.from({length:count},(_,i)=>i),optionsHash=sha('synthetic-native-table');
  const wrapper={identity:{owner,documentId:id,sourceHash,totalPages:count,inputHash:sourceHash,optionsHash,copyIndices},result:raw};
  const resultBlobSha256=await saveBlob(Buffer.from(JSON.stringify(wrapper)));
  const tables=decodeDoclingResult(raw,count,{formulaEnriched:false,verifiedBlankPages:copyIndices.map(i=>i+1)}).nativeTables;
  for(const table of tables)table.result={resultBlobSha256,derivedInputSha256:sourceHash,optionsHash,copyIndices};
  nativeTables=await prepareNativeTableCandidates({owner,documentId:id,sourceHash,tables});
  assert.equal(nativeTables.artifacts[0].status,'available');
 }
 const document={id,ownerId:owner,courseId:'',name:id,hash:sourceHash,mime:'application/pdf',origin:'synthetic-budget',originKey:id};
 const pages=Array.from({length:count},(_,i)=>({pageNumber:i+1,locator:'page:'+String(i+1),text:'Synthetic original study body '+id+' page '+String(i+1)}));
 await kernel.ingestParsedDocument(document,pages,{parserVersion:'synthetic-budget-v1',pdfVisuals:visuals,nativeTables});
 const resolved=await kernel.resolveDocumentSource(owner,{selectedDocumentTitle:id});if(resolved.status!=='resolved')throw new Error('fixture source');
 const identity:DocumentContextSource={...resolved.document,courseId:''},nodes=(await kernel.readDocumentSourcePages(owner,identity)).nodes;
 const hits=await readDocumentNodes(kernelPool(),owner,identity,nodes.map(node=>node.evidenceId));
 return {document,pages,source:identity,nodes,hits,pngs};
}

test('actual PG composition: 14 same-PDF and interleaved multi-PDF anchors retain text; shared table/author budget and rereads stay stable',
 {skip:!process.env.KERNEL_DATABASE_URL},async()=>{
 await migrateKernel();const pool=kernelPool(),owner='budget-owner-'+randomUUID();
 const a=await pdfFixture(owner,7,true),b=await pdfFixture(owner,7),single=await pdfFixture(owner,14);
 const interleaved=a.hits.flatMap((hit,i)=>[hit,b.hits[i]]),before=JSON.stringify(interleaved);
 const mixed=await kernel.readDocumentParents(owner,interleaved,{includeImages:true});
 assert.equal(mixed.anchors.length,14);assert.equal(JSON.stringify(interleaved),before);assert.equal(mixed.images.length,6);
 assert.deepEqual(mixed.imageSelection?.included.map(item=>item.anchorRank),[1,2,3,4,5,6]);
 assert.deepEqual(mixed.imageSelection?.included.map(item=>item.source.documentId),[a.source.documentId,b.source.documentId,
  a.source.documentId,b.source.documentId,a.source.documentId,b.source.documentId]);
 assert.equal(mixed.imageSelection?.omitted.length,8);
 const same=await kernel.readDocumentParents(owner,single.hits,{includeImages:true});
 assert.equal(same.anchors.length,14);assert.equal(same.images.length,6);assert.equal(same.imageSelection?.omitted.length,8);
 assert.deepEqual((await kernel.readDocumentParents(owner,interleaved,{includeImages:true})).imageSelection,mixed.imageSelection);
 await assert.rejects(readPdfVisualEvidence(pool,owner,single.source),error=>error instanceof PdfVisualEvidenceError&&error.code==='input-limit');
 const complete=await kernel.readCompleteDocumentSource(owner,single.source);
 assert.equal(complete.status,'unavailable','complete source remains all-or-unavailable');
 if(complete.status==='unavailable')assert.equal(complete.reason,'image-input-limit');

 // An omitted late-ranked PNG must still be read and verified, not silently
 // converted from corruption into a budget-omission record.
 const last=same.imageSelection!.omitted.at(-1)!,path=resolve(process.env.LIBRARY_DIR||'./data/library',last.sha256),saved=await readFile(path);
 try{await writeFile(path,'corrupt omitted PNG');await assert.rejects(kernel.readDocumentParents(owner,single.hits,{includeImages:true}),/checksum/);}
 finally{await writeFile(path,saved);}

 const authorId='author-'+randomUUID(),authorDoc={id:authorId,ownerId:owner,courseId:'',name:authorId,hash:sha(authorId),
  mime:'text/plain',origin:'synthetic-budget',originKey:authorId};
 await kernel.ingestParsedDocument(authorDoc,[{pageNumber:1,locator:'caption',text:'Synthetic author caption.'}],{parserVersion:'synthetic-author'});
 const resolution=await kernel.resolveDocumentSource(owner,{selectedDocumentTitle:authorId});if(resolution.status!=='resolved')throw new Error('author');
 const authorSource={...resolution.document,courseId:''},authorNodes=(await kernel.readDocumentSourcePages(owner,authorSource)).nodes;
 await kernel.registerDocumentStructure(owner,authorSource,{rawSourceHash:authorDoc.hash,parserVersion:'synthetic-caption',parents:[],
  nodes:[{evidenceId:authorNodes[0].evidenceId,locator:'caption',ordinal:0,kind:'caption',bodySha256:authorNodes[0].bodySha256}]});
 await kernel.registerDocumentImage(owner,authorSource,{captionEvidenceId:authorNodes[0].evidenceId,bytes:await sharp({create:{width:1,height:1,channels:3,background:'#fff'}}).png().toBuffer(),
  originalReference:'author.png',provenance:{sourceUrl:'https://example.edu/synthetic.png',revision:'synthetic-v1'}});
 const [author]=await readDocumentNodes(pool,owner,authorSource,[authorNodes[0].evidenceId]);
 const ranked=[...interleaved.slice(0,6),author,...interleaved.slice(6,13)];assert.equal(ranked.length,14);
 const table=await pdfFixture(owner,1,true,true),found=await kernel.searchNativeTableCandidates(owner,'budgettable');
 const candidates=[found.find(item=>item.source.documentId===a.source.documentId)!,found.find(item=>item.source.documentId===table.source.documentId)!];
 assert.ok(candidates.every(Boolean));
 const search=kernel.searchDocumentText,searchTables=kernel.searchNativeTableCandidates,fetch=globalThis.fetch;
 let calls=0,hide=false,inputIdentity='';
 kernel.searchDocumentText=async()=>ranked.map(({reader_selection:_selection,retrieval_mode:_mode,...hit})=>
  ({...hit,score:1,retrieval_mode:'keyword' as const}));kernel.searchNativeTableCandidates=async()=>candidates;
 globalThis.fetch=async(_url,init)=>{
  calls++;const request=JSON.parse(String(init?.body)),input=JSON.parse(request.input[1].content[0].text);
  assert.equal(input.evidence.filter((item:{kind:string})=>item.kind==='text').length,14);
  assert.equal(input.imageSelection.accounting.images,8,'six PDF pages, one author PNG and one unique table page');
  assert.equal(input.imageSelection.included.filter((item:{attachmentId:string})=>item.attachmentId===mixed.images[0].attachmentId).length,1);
  assert.ok(input.imageSelection.omitted.length>0);assert.equal(input.imageSelection.included.at(-1).anchorRank,16);
  const identity=sha(JSON.stringify(input));if(inputIdentity)assert.equal(identity,inputIdentity);inputIdentity=identity;
  if(hide)await kernel.hideParsedDocument(owner,table.source.documentId);
  return Response.json({status:'completed',model:'gpt-5-mini',usage:{input_tokens:100,output_tokens:10},output_text:JSON.stringify({
   status:'insufficient-evidence',message:'I cannot provide a sufficiently supported answer.',claims:[]})});
 };
 try{
  const options={semantic:false,aiRerank:false,includeParents:true,includeImages:true};
  const result=await kernel.answerStudyContent(owner,'Inspect these mixed study sources.',options);
  assert.equal(result.textEvidenceCount,14);assert.equal(result.imageEvidenceCount,8);assert.equal(calls,1);
  await kernel.answerStudyContent(owner,'Inspect these mixed study sources.',options);assert.equal(calls,2);
  // A table page that no longer fits is still source-checked. No fall back to
  // derived search strings, and no source failure disguised as budget omission.
  const full=createDocumentImageBudget({...DOCUMENT_IMAGE_LIMITS,images:1});full.include(image('full'),1);
  const omitted=await readNativeTableCandidateEvidence(pool,owner,[candidates[1]],{budget:full,firstAnchorRank:15});
  assert.equal(omitted.images.length,0);assert.equal(full.snapshot().omitted[0].reason,'image-count-limit');
  hide=true;await assert.rejects(kernel.answerStudyContent(owner,'Inspect these mixed study sources.',options),/no longer current|not current/);
  assert.equal(calls,3,'one mocked response, followed by source verification; no retries');
 }finally{kernel.searchDocumentText=search;kernel.searchNativeTableCandidates=searchTables;globalThis.fetch=fetch;}
});
