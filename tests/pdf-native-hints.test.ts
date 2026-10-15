import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PDFDocument,degrees} from 'pdf-lib';
import type {VisualPageOptions} from '../lib/document-parser.ts';

const directory=mkdtempSync(join(tmpdir(),'pdf-native-hint-tests-'));
Object.assign(process.env,{DATABASE_URL:':memory:',LIBRARY_DIR:join(directory,'library'),SERVICE_VAULT_DIR:join(directory,'vault'),
 AI_BUDGET_TEST_BYPASS:'true',OPENAI_API_KEY:'dummy-never-sent',LOCAL_OCR:'true',PDF_VISUAL_TILED_INPUT:'false'});
delete process.env.KERNEL_DATABASE_URL;
const sha=(bytes:string|Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP8zwACTGCSAQANHQEDgslx/wAAAABJRU5ErkJggg==','base64');
const xml=(page=1,text='<b>E A  </b>',font='7')=>`<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE pdf2xml SYSTEM "pdf2xml.dtd">\n<pdf2xml producer="poppler" version="22.12.0"><page number="${page}" position="absolute" top="0" left="0" height="200" width="200"><fontspec id="7" size="12" family="ABCDEF+Example-Bold" color="#000000"/><text top="10.125" left="20.25" width="31.75" height="13.25" font="${font}">${text}</text></page></pdf2xml>`;
let stdoutXml:string|undefined,failProducer=false,parses=0,renders=0;
const originalExec=childProcess.execFile,originalFetch=globalThis.fetch;
childProcess.execFile=((file:string,args:string[],_options:unknown,callback:(error:Error|null,stdout?:string,stderr?:string)=>void)=>{
 void(async()=>{
  if(file==='pdftoppm'){renders++;await writeFile(args.at(-1)+'.png',png);return {stdout:'',stderr:''};}
  assert.equal(file,'pdftohtml');if(failProducer)throw new Error('controlled missing producer');
  if(args[0]==='-v')return {stdout:'',stderr:'pdftohtml version 22.12.0'};
  assert.deepEqual(args.slice(0,8),['-xml','-noroundcoord','-fontfullname','-zoom','1','-i','-stdout','-nomerge']);
  assert.equal(args.includes('-hidden'),false);assert.equal(args.includes('-nodrm'),false);
  const bytes=await readFile(args.at(-1)!);const pdf=await PDFDocument.load(bytes);
  assert.ok(Number(args[9])<=pdf.getPageCount(),'CLI reads the whole original PDF at the physical page, not a mislabeled derived page');
  assert.equal(args[8],'-f');assert.equal(args[10],'-l');assert.equal(args[9],args[11]);parses++;
  return {stdout:stdoutXml??xml(Number(args[9])),stderr:''};
 })().then(value=>callback(null,value.stdout,value.stderr),error=>callback(error));return {};
}) as unknown as typeof childProcess.execFile;
syncBuiltinESMExports();
const {preparePdfNativeHintSource,decodePdfNativeHintXml,nativeHintCanonical,PDF_NATIVE_HINT_MAX_BYTES,PDF_NATIVE_HINT_POLICY}=await import('../lib/pdf-native-hints.ts');
const {nativeHintCacheParser}=await import('../lib/pdf-native-hint-cache.ts');
after(()=>{globalThis.fetch=originalFetch;childProcess.execFile=originalExec;syncBuiltinESMExports();rmSync(directory,{recursive:true,force:true});});
async function fixture(pages=2){const pdf=await PDFDocument.create();for(let i=0;i<pages;i++)pdf.addPage([200,200]);
 pdf.setCreationDate(new Date(0));pdf.setModificationDate(new Date(0));return {pdf,bytes:await pdf.save()};}
const binding={sourcePdfSha256:'a'.repeat(64),physicalPage:1,png:{sha256:sha(png),width:2,height:2},
 frame:{mediaBox:{x:0,y:0,width:200,height:200},cropBox:{x:0,y:0,width:200,height:200},rotationDegrees:0,userUnit:1}};

test('native runs retain actual compound text/box and observed tags, not invented glyphs or font semantics',()=>{
 const hint=decodePdfNativeHintXml(xml(),binding,'22.12.0');assert.equal(hint.sidecar.status,'available');
 assert.equal(hint.sidecar.runs?.length,1);assert.deepEqual(hint.sidecar.runs?.[0],{text:'E A  ',box:{left:20.25,top:10.125,width:31.75,height:13.25},fontId:'f0',
  observedSpans:[{text:'E A  ',boldTagObserved:true,italicTagObserved:false}]});
 assert.equal(hint.sidecar.fonts?.[0].sourceFontFile,null);
 const regular=decodePdfNativeHintXml(xml(1,'Q'),binding,'22.12.0');
 assert.equal(regular.sidecar.runs?.[0].observedSpans[0].boldTagObserved,false,'font fullname containing Bold is not a mathematical/style inference');
 assert.equal(decodePdfNativeHintXml(xml(1,'&lt;&amp;&#x3b5;'),binding,'22.12.0').sidecar.runs?.[0].text,'<&ε');
});

test('unknown fonts, zero content, unsupported/unsafe XML and mismatched producer/page/frame explicitly unavailable',()=>{
 for(const [input,reason] of [
  [xml(1,'E','missing'),'unknown-font'],[xml(1,'  '),'no-native-text'],
  [xml().replace('SYSTEM "pdf2xml.dtd"','[<!ENTITY external SYSTEM "https://never.fetch/">]'),'unsupported-xml-declaration'],
  [xml(1,'&unknown;'),'unsupported-xml-entity'],[xml(2),'page-frame-mismatch'],
  [xml().replace('width="200"','width="201"'),'page-frame-mismatch'],
  [xml().replace('version="22.12.0"','version="unknown"'),'producer-or-page-mismatch'],
 ]){const result=decodePdfNativeHintXml(input,binding,'22.12.0');assert.equal(result.sidecar.status,'unavailable');assert.equal(result.sidecar.reason,reason);assert.equal(result.sidecar.runs,undefined);}
});

test('64 KiB uses actual serialized UTF8 bytes and retains no silently truncated runs',()=>{
 const result=decodePdfNativeHintXml(xml(1,'字'.repeat(12000)),binding,'22.12.0');
 assert.equal(result.sidecar.status,'unavailable');assert.equal(result.sidecar.reason,'sidecar-byte-limit');assert.equal(result.sidecar.runs,undefined);
 assert.ok(Buffer.byteLength(nativeHintCanonical(result.sidecar))<=PDF_NATIVE_HINT_MAX_BYTES);
});

test('source/physical-page/PNG binding is stable and affects policy identity; unknown producer is unavailable',async()=>{
 const {bytes}=await fixture(),source=sha(bytes),collect=await preparePdfNativeHintSource(bytes,source);
 await assert.rejects(preparePdfNativeHintSource(bytes,'f'.repeat(64)),/checksum/);
 await assert.rejects(collect(3,png),/physical page/);
 const first=await collect(2,png),again=await collect(2,png);
 assert.equal(first.sidecar.status,'available');assert.equal(first.sidecarSha256,again.sidecarSha256);
 assert.equal(first.sidecar.binding.sourcePdfSha256,source);assert.equal(first.sidecar.binding.physicalPage,2);assert.equal(first.sidecar.binding.png.sha256,sha(png));
 const page1=await collect(1,png);assert.notEqual(first.sidecarSha256,page1.sidecarSha256);
 assert.notEqual(nativeHintCacheParser(source,'gpt-5.4-mini',first),nativeHintCacheParser(source,'gpt-5.4-mini',page1));
 failProducer=true;try{const missing=await collect(2,png);assert.equal(missing.sidecar.status,'unavailable');assert.equal(missing.sidecar.reason,'poppler-unavailable');assert.notEqual(missing.sidecarSha256,first.sidecarSha256);}finally{failProducer=false;}
});

test('unsupported rotation is unavailable without invoking the native producer',async()=>{
 const {pdf}=await fixture(1);pdf.getPage(0).setRotation(degrees(90));const bytes=await pdf.save();
 const collect=await preparePdfNativeHintSource(bytes,sha(bytes)),before=parses;
 assert.equal((await collect(1,png)).sidecar.reason,'unsupported-page-frame');assert.equal(parses,before);
});

test('formal parser sends actual hints plus unchanged original PNG and isolates durable cache from old defaults',async()=>{
 const {transcribePdfVisualPages,selectedVisualPageCacheParser}=await import('../lib/document-parser.ts');
 const {database}=await import('../lib/database.ts');
 const {bytes}=await fixture(),hash=sha(bytes),id='native-two-page-source';let calls=0;
 const legacyParser=selectedVisualPageCacheParser(hash,'gpt-5.4-mini',true);
 await database.prepare('INSERT INTO library_parse_pages VALUES(?,?,?,?)').bind(id,legacyParser,1,'Historical selected-v3 body').run();
 const body='Observed source \\(\\mathbf{E}\\).';
 globalThis.fetch=async(_input,init)=>{calls++;const request=JSON.parse(String(init?.body)),content=request.input[0].content;
  assert.equal(request.model,'gpt-5.4-mini');assert.equal(request.max_output_tokens,9000);assert.deepEqual(request.reasoning,{effort:'low'});
  assert.ok(content[0].text.includes('忠实版本 v3'));assert.equal(content.length,3);assert.equal(content[1].type,'input_text');
  const hint=JSON.parse(content[1].text.slice(content[1].text.indexOf('\n')+1));
  assert.equal(hint.sidecarSha256,sha(nativeHintCanonical(hint.sidecar)));assert.equal(hint.sidecar.binding.sourcePdfSha256,hash);
  assert.equal(hint.sidecar.binding.physicalPage,2);assert.equal(hint.sidecar.status,'available');
  assert.equal(content[2].image_url,'data:image/png;base64,'+png.toString('base64'));assert.equal(content[2].detail,'original');
  return Response.json({status:'completed',model:'gpt-5.4-mini-2026-03-17',output_text:JSON.stringify({text:body,complete:true,uncertain_spans:[]})});};
 const options:VisualPageOptions={pageNumbers:[2],expectedSourceHash:hash,model:'gpt-5.4-mini',imageInput:true,nativeTextHints:PDF_NATIVE_HINT_POLICY};
 try{
  assert.equal((await transcribePdfVisualPages(id,bytes,options))[0].text,body);
  assert.equal((await transcribePdfVisualPages(id,bytes,options))[0].text,body);assert.equal(calls,1);
  assert.equal((await transcribePdfVisualPages(id,bytes,{...options,nativeTextHints:undefined}))[0].text,'Historical selected-v3 body');assert.equal(calls,1);
  const saved=(await database.prepare('SELECT parser,body FROM library_parse_pages WHERE document_id=? AND parser LIKE ?').bind(id,'pdf-visual-native-hint-cache-v1:%').all<{parser:string;body:string}>()).results;
  assert.equal(saved.length,1);const envelope=JSON.parse(saved[0].body);
  assert.equal(envelope.requestWire,undefined,'original image wire is not duplicated into SQLite');
  assert.match(envelope.requestSha256,/^[a-f0-9]{64}$/);assert.equal(sha(envelope.rawResponse),envelope.rawResponseSha256);
  assert.equal(envelope.hints.sidecar.binding.png.sha256,sha(png));assert.equal(envelope.httpStatus,200);
  await database.prepare('UPDATE library_parse_pages SET body=? WHERE document_id=? AND parser=?').bind(JSON.stringify({...envelope,rawResponse:'corrupted'}),id,saved[0].parser).run();
  await assert.rejects(transcribePdfVisualPages(id,bytes,options),/cache identity differs/);assert.equal(calls,1,'corruption never silently recharges');
  await assert.rejects(transcribePdfVisualPages(id,bytes,{...options,imageInput:false}),/require selected original PNG/);assert.equal(calls,1);
 }finally{globalThis.fetch=originalFetch;}
});

test('Docling visual route passes trusted opt-in to the same formal parser, without a Docling or formula call',async t=>{
 const {saveDocument}=await import('../lib/library.ts');const {kernel}=await import('../lib/kernel/service.ts');
 const {convertDocumentWithDocling}=await import('../lib/kernel/docling.ts');const {bytes}=await fixture(1);
 const id=await saveDocument('native-owner','','upload','native-formal','native.pdf','application/pdf',bytes);
 const settings={DOCLING_URL:'http://docling.must-not-be-called',DOCLING_NATIVE_TEXT_FASTPATH:'false',PDF_SCAN_TRANSCRIPTION_BACKEND:'ai',
  PDF_VISUAL_IMAGE_INPUT:'true',PDF_VISUAL_NATIVE_HINTS:PDF_NATIVE_HINT_POLICY,OPENAI_MODEL:'gpt-5.4-mini'};
 const old=Object.fromEntries(Object.keys(settings).map(key=>[key,process.env[key]]));Object.assign(process.env,settings);
 const publish=t.mock.method(kernel,'ingestParsedDocument',async(...[,pages]:Parameters<typeof kernel.ingestParsedDocument>)=>{assert.equal(pages[0].text,'Source retained.');});
 let calls=0;globalThis.fetch=async(url,init)=>{assert.equal(String(url),'https://api.openai.com/v1/responses');calls++;
  const content=JSON.parse(String(init?.body)).input[0].content;assert.ok(content[1].text.includes(PDF_NATIVE_HINT_POLICY));
  return Response.json({status:'completed',model:'gpt-5.4-mini-2026-03-17',output_text:JSON.stringify({text:'Source retained.',complete:true,uncertain_spans:[]})});};
 try{await convertDocumentWithDocling('native-owner',id);assert.equal(calls,1);assert.equal(publish.mock.callCount(),1);assert.ok(renders>0);}
 finally{publish.mock.restore();globalThis.fetch=originalFetch;for(const [key,value] of Object.entries(old)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
});
