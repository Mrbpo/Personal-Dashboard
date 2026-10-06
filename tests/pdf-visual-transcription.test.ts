import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PDFDocument} from 'pdf-lib';

const directory=mkdtempSync(join(tmpdir(),'pdf-visual-tests-'));
process.env.DATABASE_URL=':memory:';
process.env.LIBRARY_DIR=directory;
process.env.SERVICE_VAULT_DIR=join(directory,'vault');
process.env.AI_BUDGET_TEST_BYPASS='true';
process.env.OPENAI_API_KEY='dummy-key-never-sent';
process.env.PDF_VISUAL_TILED_INPUT='false';
after(()=>rmSync(directory,{recursive:true,force:true}));

async function fixture(key:string,pageCount:number){
 const pdf=await PDFDocument.create();
 for(let page=0;page<pageCount;page++)pdf.addPage();
 const bytes=await pdf.save();
 const {saveDocument}=await import('../lib/library.ts');
 return {bytes,id:await saveDocument('visual-test-owner','','upload',key,key+'.pdf','application/pdf',bytes)};
}

test('visual transcription resumes only unfinished pages and reuses completed page text',async()=>{
 const {database:db}=await import('../lib/database.ts');
 const {transcribePdfVisualPages}=await import('../lib/document-parser.ts');
 const {id,bytes}=await fixture('resume',2);
 const original=globalThis.fetch;let calls=0;
 globalThis.fetch=async(input,init)=>{
  assert.equal(String(input),'https://api.openai.com/v1/responses');
  const request=JSON.parse(String(init?.body));
  const uploaded=request.input[0].content.find((part:{type:string})=>part.type==='input_file');
  assert.equal((await PDFDocument.load(Buffer.from(uploaded.file_data.split(',')[1],'base64'))).getPageCount(),1);
  calls++;
  if(calls===2)return new Response(null,{status:503});
  return Response.json({output_text:JSON.stringify({text:calls===1?'First page \\[x^2\\]':'Second page \\[y^2\\]',complete:true,uncertain_spans:[]})});
 };
 try{
  await assert.rejects(transcribePdfVisualPages(id,bytes),/第 2 页视觉转写失败/);
  const cached=(await db.prepare("SELECT page,body FROM library_parse_pages WHERE document_id=? AND parser='pdf-visual-v1' ORDER BY page").bind(id).all<{page:number;body:string}>()).results;
  assert.deepEqual(cached,[{page:0,body:'First page \\[x^2\\]'}]);
  assert.deepEqual(await transcribePdfVisualPages(id,bytes),[
   {pageNumber:1,locator:'第 1 页',text:'First page \\[x^2\\]'},
   {pageNumber:2,locator:'第 2 页',text:'Second page \\[y^2\\]'},
  ]);
  assert.equal(calls,3,'retry must not request the completed first page again');
  await transcribePdfVisualPages(id,bytes);
  assert.equal(calls,3,'fully completed document must use only cached pages');
 }finally{globalThis.fetch=original;}
});

test('incomplete visual pages are not cached or published and leave the prior index intact',async t=>{
 const {database:db}=await import('../lib/database.ts');
 const {kernel}=await import('../lib/kernel/service.ts');
 const {convertDocumentWithDocling}=await import('../lib/kernel/docling.ts');
 const {id,bytes}=await fixture('incomplete',1);
 await db.prepare("INSERT INTO library_parse_pages VALUES (?, 'docling-v2-search', 0, 'Previous complete text')").bind(id).run();
 await db.prepare('INSERT INTO library_chunks VALUES (?,?,?,?,?,?)').bind(id+':old',id,0,'第 1 页','Previous complete text','old-hash').run();
 await db.prepare("UPDATE library_documents SET status='ready' WHERE id=?").bind(id).run();
 const {transcribePdfVisualPages}=await import('../lib/document-parser.ts');
 const previousFetch=globalThis.fetch;
 const settings=['DOCLING_URL','DOCLING_NATIVE_TEXT_FASTPATH','PDF_SCAN_TRANSCRIPTION_BACKEND'] as const;
 const previousSettings=settings.map(name=>process.env[name]);
 process.env.DOCLING_URL='http://docling.must-not-be-called';
 process.env.DOCLING_NATIVE_TEXT_FASTPATH='false';
 process.env.PDF_SCAN_TRANSCRIPTION_BACKEND='ai';
 const publish=t.mock.method(kernel,'ingestParsedDocument',async()=>{throw new Error('Incomplete text must not be published');});
 let calls=0;
 try{
  for(const result of [
   {output_text:JSON.stringify({text:'Partial visible equation',complete:false,uncertain_spans:[]})},
   {status:'incomplete',output_text:JSON.stringify({text:'Looks complete but provider was truncated',complete:true,uncertain_spans:[]})},
  ]){
   globalThis.fetch=async input=>{
    assert.equal(String(input),'https://api.openai.com/v1/responses');
    calls++;return Response.json(result);
   };
   await assert.rejects(convertDocumentWithDocling('visual-test-owner',id),/第 1 页视觉转写不完整/);
   assert.equal(await db.prepare("SELECT 1 FROM library_parse_pages WHERE document_id=? AND parser='pdf-visual-v1'").bind(id).first(),null);
   assert.equal(publish.mock.callCount(),0);
   assert.equal((await db.prepare('SELECT body FROM library_chunks WHERE document_id=?').bind(id).first<{body:string}>())?.body,'Previous complete text');
   assert.equal((await db.prepare('SELECT status FROM library_documents WHERE id=?').bind(id).first<{status:string}>())?.status,'ready');
  }
  globalThis.fetch=async()=>{calls++;return Response.json({output_text:JSON.stringify({text:'Now fully transcribed \\[x^2\\]',complete:true,uncertain_spans:[]})});};
  assert.equal((await transcribePdfVisualPages(id,bytes))[0].text,'Now fully transcribed \\[x^2\\]');
  assert.equal(calls,3,'neither incomplete response may suppress a later retry');
 }finally{
  globalThis.fetch=previousFetch;
  settings.forEach((name,index)=>{if(previousSettings[index]===undefined)delete process.env[name];else process.env[name]=previousSettings[index];});
  publish.mock.restore();
 }
});

test('24 visual pages are allowed but 25 are rejected before requests or partial caching',async()=>{
 const {database:db}=await import('../lib/database.ts');
 const {transcribePdfVisualPages,PDF_VISUAL_PAGES_PER_DOCUMENT}=await import('../lib/document-parser.ts');
 assert.equal(PDF_VISUAL_PAGES_PER_DOCUMENT,24);
 const accepted=await fixture('limit-24',24),rejected=await fixture('limit-25',25);
 const original=globalThis.fetch;let calls=0;
 globalThis.fetch=async()=>{calls++;return Response.json({output_text:JSON.stringify({text:'Page '+calls,complete:true,uncertain_spans:[]})});};
 try{
  await assert.rejects(transcribePdfVisualPages(rejected.id,rejected.bytes),/超过 24 页/);
  assert.equal(calls,0);
  assert.equal(await db.prepare('SELECT 1 FROM library_parse_pages WHERE document_id=?').bind(rejected.id).first(),null);
  const pages=await transcribePdfVisualPages(accepted.id,accepted.bytes);
  assert.equal(pages.length,24);
  assert.deepEqual(pages.map(page=>page.pageNumber),Array.from({length:24},(_,index)=>index+1));
  assert.equal(calls,24);
  await transcribePdfVisualPages(accepted.id,accepted.bytes);
  assert.equal(calls,24,'a retry must not expand or recharge the permitted document');
 }finally{globalThis.fetch=original;}
});

test('fully processed pages preserve uncertainty in place and malformed warning arrays never cache',async()=>{
 const {database:db}=await import('../lib/database.ts');
 const {transcribePdfVisualPages}=await import('../lib/document-parser.ts');
 const valid=await fixture('uncertain-spans',1),invalid=await fixture('invalid-warning-array',1);
 const source='Visible heading\nLocal equation: [无法可靠辨认]\nVisible conclusion';
 const expected='[本页存在无法可靠辨认的片段，须核对原 PDF]\n[无法可靠辨认: 左下公式末项字迹模糊]\n'+source;
 const original=globalThis.fetch;let calls=0;
 globalThis.fetch=async()=>{calls++;return Response.json({output_text:JSON.stringify({text:source,complete:true,uncertain_spans:['左下公式末项字迹模糊']})});};
 try{
  assert.equal((await transcribePdfVisualPages(valid.id,valid.bytes))[0].text,expected);
  assert.equal((await db.prepare("SELECT body FROM library_parse_pages WHERE document_id=? AND parser='pdf-visual-v1' AND page=0").bind(valid.id).first<{body:string}>())?.body,expected);
  assert.equal((await transcribePdfVisualPages(valid.id,valid.bytes))[0].text,expected);
  assert.equal(calls,1,'honest localized uncertainty can be cached without guessing missing content');
  for(const uncertain_spans of ['not-an-array',[17],Array(101).fill('region'),['x'.repeat(1001)]]){
   globalThis.fetch=async()=>{calls++;return Response.json({output_text:JSON.stringify({text:source,complete:true,uncertain_spans})});};
   await assert.rejects(transcribePdfVisualPages(invalid.id,invalid.bytes),/识别警告格式无效/);
   assert.equal(await db.prepare("SELECT 1 FROM library_parse_pages WHERE document_id=? AND parser='pdf-visual-v1'").bind(invalid.id).first(),null);
  }
 }finally{globalThis.fetch=original;}
});
