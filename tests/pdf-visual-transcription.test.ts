import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {inspect} from 'node:util';
import {PDFDocument} from 'pdf-lib';
import {PdfVisualStructureError,visualMathStructureIssue,visualTextControlIssue} from '../lib/pdf-visual-structure.ts';

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

test('formal visual conversion uses source-bound faithful blocks v4 and never certifies an old v1 cache',async t=>{
 const {database:db}=await import('../lib/database.ts');
 const {kernel}=await import('../lib/kernel/service.ts');
 const {convertDocumentWithDocling}=await import('../lib/kernel/docling.ts');
 const {selectedVisualPageCacheParser,transcribePdfVisualPages}=await import('../lib/document-parser.ts');
 const {digest}=await import('../lib/library.ts');
 const {id,bytes}=await fixture('formal-faithful-policy',1),sourceHash=digest(bytes);
 const old='Old unversioned visual cache must remain historical';
 await db.prepare("INSERT INTO library_parse_pages VALUES (?, 'pdf-visual-v1', 0, ?)").bind(id,old).run();
 const settings={DOCLING_URL:'http://docling.must-not-be-called',DOCLING_NATIVE_TEXT_FASTPATH:'false',
  PDF_SCAN_TRANSCRIPTION_BACKEND:'ai',PDF_VISUAL_IMAGE_INPUT:'false',LOCAL_OCR:'false'};
 const previousSettings=Object.fromEntries(Object.keys(settings).map(key=>[key,process.env[key]]));
 Object.assign(process.env,settings);
 const publish=t.mock.method(kernel,'ingestParsedDocument',async(...[,pages]:Parameters<typeof kernel.ingestParsedDocument>)=>{
  assert.deepEqual(pages,[{pageNumber:1,locator:'第 1 页',text:'Faithful source typo \\(\\psi\\)'}]);
 });
 const head=t.mock.method(kernel,'documentIngestionHead',async()=>null);
 const originalFetch=globalThis.fetch;let calls=0;
 globalThis.fetch=async(input,init)=>{
  assert.equal(String(input),'https://api.openai.com/v1/responses');calls++;
  const request=JSON.parse(String(init?.body)),content=request.input[0].content;
  assert.equal(request.model,'gpt-5-mini');assert.equal(request.max_output_tokens,9000);
  assert.deepEqual(request.reasoning,{effort:'low'});
  assert.ok(content[0].text.includes('忠实版本 v3'));
  assert.ok(content[0].text.includes('严禁根据知识、常见公式或上下文纠正'));
  assert.equal((await PDFDocument.load(Buffer.from(content[1].file_data.split(',')[1],'base64'))).getPageCount(),1);
  return Response.json({output_text:JSON.stringify({blocks:[{kind:'text',text:'Faithful source typo \\(\\psi\\)'}],complete:true,uncertain_spans:[]})});
 };
 try{
  await convertDocumentWithDocling('visual-test-owner',id);
  const parser=selectedVisualPageCacheParser(sourceHash,'gpt-5-mini',false);
  const boundCache=(await db.prepare('SELECT body FROM library_parse_pages WHERE document_id=? AND parser=? AND page=0')
   .bind(id,parser).first<{body:string}>())!.body;assert.equal(JSON.parse(boundCache).searchText,'Faithful source typo \\(\\psi\\)');
  assert.equal((await db.prepare("SELECT body FROM library_parse_pages WHERE document_id=? AND parser='pdf-visual-v1' AND page=0")
   .bind(id).first<{body:string}>())?.body,old);
  await convertDocumentWithDocling('visual-test-owner',id);
  assert.equal(calls,1,'the matching faithful source-bound cache must need no additional model request');
  assert.equal(publish.mock.callCount(),2);
  await assert.rejects(transcribePdfVisualPages(id,bytes,{pageNumbers:[1],expectedSourceHash:'f'.repeat(64)}),/原件校验失败/);
  assert.equal(calls,1,'a mismatched source must fail before using the cache or making a request');
 }finally{
  globalThis.fetch=originalFetch;publish.mock.restore();head.mock.restore();
  for(const [key,value] of Object.entries(previousSettings)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
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
 const source='Visible heading\nLocal equation: \\(x^2\\) and [无法可靠辨认]\nVisible conclusion';
 const note='左下未闭合片段 \\[\n\\begin{cases} 无法辨认';
 const expected='[本页存在无法可靠辨认的片段，须核对原 PDF]\n[无法可靠辨认: '+note+']\n'+source;
 const original=globalThis.fetch;let calls=0;
 globalThis.fetch=async()=>{calls++;return Response.json({output_text:JSON.stringify({text:source,complete:true,uncertain_spans:[note]})});};
 try{
  assert.equal((await transcribePdfVisualPages(valid.id,valid.bytes))[0].text,expected);
  assert.equal((await db.prepare("SELECT body FROM library_parse_pages WHERE document_id=? AND parser='pdf-visual-v1' AND page=0").bind(valid.id).first<{body:string}>())?.body,expected);
  await assert.rejects(transcribePdfVisualPages(valid.id,valid.bytes),error=>{
   assert.ok(error instanceof PdfVisualStructureError);
   assert.equal(error.code,'PDF_VISUAL_CACHE_STRUCTURE_UNVERIFIED');
   assert.equal(error.rawOutput,expected);
   return true;
  });
  assert.equal(calls,1,'ambiguous flat warning/body boundaries require review, never a paid automatic retry');
  assert.equal((await db.prepare("SELECT body FROM library_parse_pages WHERE document_id=? AND parser='pdf-visual-v1' AND page=0").bind(valid.id).first<{body:string}>())?.body,expected);
  for(const uncertain_spans of ['not-an-array',[17],Array(101).fill('region'),['x'.repeat(1001)]]){
   globalThis.fetch=async()=>{calls++;return Response.json({output_text:JSON.stringify({text:source,complete:true,uncertain_spans})});};
   await assert.rejects(transcribePdfVisualPages(invalid.id,invalid.bytes),/识别警告格式无效/);
   assert.equal(await db.prepare("SELECT 1 FROM library_parse_pages WHERE document_id=? AND parser='pdf-visual-v1'").bind(invalid.id).first(),null);
  }
 }finally{globalThis.fetch=original;}
});

test('visual structure gate permits whitespace, row breaks and paired math but rejects explicit malformed structure',()=>{
 for(let code=0;code<32;code++){
  const value='before'+String.fromCharCode(code)+'after';
  assert.equal(visualTextControlIssue(value)===null,[9,10,13].includes(code),`C0 U+${code.toString(16)}`);
 }
 for(const text of [
  String.raw`Plain prose and \(\bar{x}+\beta\).`,
  String.raw`\[A=\begin{bmatrix}1&0\\0&1\end{bmatrix}\]`,
  String.raw`\begin{align*}x&=1\\y&=2\end{align*}`,
  String.raw`\(\begin{custom*}\begin{matrix}1\\[2pt]2\end{matrix}\end{custom*}\)`,
  String.raw`Escaped markers \\( and \\begin{not-a-real-opener}; $ remains outside this gate.`,
 ])assert.equal(visualMathStructureIssue(text),null,text);
 for(const text of [
  String.raw`\(missing`,String.raw`\]`,String.raw`\[x\)`,
  String.raw`\begin{matrix}x`,String.raw`\end{matrix}`,
  String.raw`\begin{matrix}\end{cases}`,String.raw`\[\begin{matrix}x\]\end{matrix}`,
  String.raw`\begin{}`,String.raw`\begin{matrix`,String.raw`\begin{matrix}\begin{cases}\end{matrix}\end{cases}`,
  String.raw`\(x\(y\)\)`,String.raw`\[x\(y\)\]`,String.raw`\(x\[y\]\)`,
 ])assert.notEqual(visualMathStructureIssue(text),null,text);
});

test('decoded visual structure failures preserve raw output and never cache or automatically retry',async()=>{
 const {database:db}=await import('../lib/database.ts');
 const {transcribePdfVisualPages}=await import('../lib/document-parser.ts');
 const original=globalThis.fetch;let calls=0;
 const backspaces=String.raw`{"text":"Value: \bar{x} + \beta","complete":true,"uncertain_spans":[]}`;
 assert.equal([...JSON.parse(backspaces).text].filter(char=>char==='\u0008').length,2);
 const invalid=[backspaces,...[
  {text:String.raw`Unclosed \[x^2`,uncertain_spans:[]},
  {text:String.raw`\[\begin{matrix}1&0\\0&1\end{cases}\]`,uncertain_spans:[]},
  {text:'\u000cVisible text',uncertain_spans:[]},
  {text:'Valid page',uncertain_spans:['warning\u0000']},
 ].map(value=>JSON.stringify({...value,complete:true}))];
 try{
  for(const [index,raw] of invalid.entries()){
   const doc=await fixture('invalid-structure-'+index,1),before=calls;
   globalThis.fetch=async()=>{calls++;return Response.json({output_text:raw});};
   await assert.rejects(transcribePdfVisualPages(doc.id,doc.bytes),error=>{
    assert.ok(error instanceof PdfVisualStructureError);
    assert.equal(error.code,'PDF_VISUAL_TEXT_STRUCTURE_INVALID');
    assert.equal(error.rawOutput,raw);assert.equal(error.rawFormat,'provider-output-json');
    assert.equal(Object.prototype.propertyIsEnumerable.call(error,'rawOutput'),false);
    assert.ok(!error.message.includes(raw));assert.ok(!JSON.stringify(error).includes(raw));assert.ok(!inspect(error).includes(raw));
    return true;
   });
   assert.equal(calls,before+1);
   assert.equal(await db.prepare('SELECT 1 FROM library_parse_pages WHERE document_id=?').bind(doc.id).first(),null);
  }
  const valid=await fixture('valid-matrix-structure',1);
  const text='Rows\tand\r\n'+String.raw`\[\begin{pmatrix}1&0\\0&1\end{pmatrix}\]`;
  globalThis.fetch=async()=>{calls++;return Response.json({output_text:JSON.stringify({text,complete:true,uncertain_spans:[]})});};
  const before=calls;
  assert.equal((await transcribePdfVisualPages(valid.id,valid.bytes))[0].text,text);
  assert.equal((await transcribePdfVisualPages(valid.id,valid.bytes))[0].text,text);
  assert.equal(calls,before+1,'normal paired math and legal whitespace remain reusable');
 }finally{globalThis.fetch=original;}
});

test('invalid existing full and selected visual caches are preserved and refused without provider requests',async()=>{
 const {database:db}=await import('../lib/database.ts');
 const {transcribePdfVisualPages,selectedVisualPageCacheParser}=await import('../lib/document-parser.ts');
 const {createHash}=await import('node:crypto');
 const original=globalThis.fetch;let calls=0;
 globalThis.fetch=async()=>{calls++;throw new Error('Invalid cache must not trigger a provider request');};
 try{
  for(const [index,body] of ['back\u0008space',String.raw`\[unclosed`,String.raw`\begin{matrix}missing`].entries()){
   const doc=await fixture('invalid-existing-cache-'+index,1);
   const selected=index===2;
   const parser=selected?selectedVisualPageCacheParser(createHash('sha256').update(doc.bytes).digest('hex'),'gpt-5-mini',false):'pdf-visual-v1';
   await db.prepare('INSERT INTO library_parse_pages VALUES(?,?,0,?)').bind(doc.id,parser,body).run();
   await db.prepare("INSERT INTO library_parse_pages VALUES(?,'unrelated-parser',0,'Untouched other cache')").bind(doc.id).run();
   await assert.rejects(transcribePdfVisualPages(doc.id,doc.bytes,selected?{pageNumbers:[1],model:'gpt-5-mini',imageInput:false}:{}),error=>{
    assert.ok(error instanceof PdfVisualStructureError);assert.equal(error.code,'PDF_VISUAL_TEXT_STRUCTURE_INVALID');
    assert.equal(error.rawOutput,body);assert.equal(error.rawFormat,'cached-page-text');return true;
   });
   assert.equal((await db.prepare('SELECT body FROM library_parse_pages WHERE document_id=? AND parser=?').bind(doc.id,parser).first<{body:string}>())?.body,body);
   assert.equal((await db.prepare("SELECT body FROM library_parse_pages WHERE document_id=? AND parser='unrelated-parser'").bind(doc.id).first<{body:string}>())?.body,'Untouched other cache');
  }
  assert.equal(calls,0);
 }finally{globalThis.fetch=original;}
});

test('selected visual pages copy the exact original page, keep global numbering and reuse only source-specific cache',async()=>{
 const {transcribePdfVisualPages,SELECTED_VISUAL_PARSER_VERSION,selectedVisualPageCacheParser}=await import('../lib/document-parser.ts');
 const {database:db}=await import('../lib/database.ts');
 const {createHash}=await import('node:crypto');
 const pdf=await PDFDocument.create();
 for(let index=0;index<30;index++)pdf.addPage([400+index,600]);
 const bytes=await pdf.save(),id='selected-original-29';
 const hash=createHash('sha256').update(bytes).digest('hex');
 const oldCache='pdf-visual-selected-v2:'+createHash('sha256').update(JSON.stringify({sourceHash:hash,model:'gpt-5-mini',imageInput:false,tiled:false,promptVersion:2})).digest('hex');
 await db.prepare('INSERT INTO library_parse_pages VALUES (?,?,?,?)').bind(id,oldCache,28,'Previous inline-only result').run();
 assert.equal(SELECTED_VISUAL_PARSER_VERSION,'pdf-visual-selected-v4');
 assert.notEqual(selectedVisualPageCacheParser(hash,'gpt-5-mini',false),oldCache);
 const original=globalThis.fetch;let calls=0;
 globalThis.fetch=async(_input,init)=>{
  const request=JSON.parse(String(init?.body));
  const uploaded=request.input[0].content.find((part:{type:string})=>part.type==='input_file');
  const copy=await PDFDocument.load(Buffer.from(uploaded.file_data.split(',')[1],'base64'));
  assert.equal(copy.getPageCount(),1);
  assert.equal(copy.getPage(0).getWidth(),428,'original page 29 must be copied, not page 1');
  const prompt=request.input[0].content.find((part:{type:string})=>part.type==='input_text').text;
  assert.match(prompt,/忠实版本 v3/);
  for(const marker of ['\\mathbf','\\boldsymbol','\\tag','\\[','\\]'])assert.ok(prompt.includes(marker));
  assert.match(prompt,/不能用行内分隔符代替/);
  assert.match(prompt,/不进行数学纠错/);
  calls++;
  return Response.json({output_text:JSON.stringify({blocks:[{kind:'text',text:'Faithful selected-page text \\(\\psi\\)'}],complete:true,uncertain_spans:[]})});
 };
 try{
  const options={pageNumbers:[29],imageInput:false};
  const pages=await transcribePdfVisualPages(id,bytes,options);
  assert.deepEqual(pages.map(page=>[page.pageNumber,page.locator]),[[29,'第 29 页']]);
  await transcribePdfVisualPages(id,bytes,options);
  assert.equal(calls,1);
  assert.equal((await db.prepare('SELECT body FROM library_parse_pages WHERE document_id=? AND parser=? AND page=28').bind(id,oldCache).first<{body:string}>())?.body,'Previous inline-only result');
  pdf.setTitle('Source revision');
  await transcribePdfVisualPages(id,await pdf.save(),options);
  assert.equal(calls,2,'changed original hash must not reuse the previous selected-page text');
 }finally{globalThis.fetch=original;}
});

test('selected visual page/hash validation rejects before a model request',async()=>{
 const {transcribePdfVisualPages}=await import('../lib/document-parser.ts');
 const pdf=await PDFDocument.create();pdf.addPage();pdf.addPage();const bytes=await pdf.save();
 const original=globalThis.fetch;let calls=0;
 globalThis.fetch=async()=>{calls++;throw new Error('Unexpected request');};
 try{
  for(const pageNumbers of [[],[0],[3],[1,1],[1.5]])
   await assert.rejects(transcribePdfVisualPages('invalid-selection',bytes,{pageNumbers}),/原始页码无效/);
  await assert.rejects(transcribePdfVisualPages('wrong-original',bytes,{pageNumbers:[1],expectedSourceHash:'0'.repeat(64)}),/原件校验失败/);
  assert.equal(calls,0);
 }finally{globalThis.fetch=original;}
});
