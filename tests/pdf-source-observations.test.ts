import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PDFDocument,PDFName,PDFNumber,degrees,pushGraphicsState,popGraphicsState,rectangle,clip,endPath} from 'pdf-lib';
import sharp from 'sharp';
import {collectPdfSourceObservations,bindPdfSourceObservation,observationBinding,observationImage,observationJson,
 encodeSourceObservationCache,readSourceObservationCache,PDF_SOURCE_OBSERVATION_LIMITS} from '../lib/pdf-source-observations.ts';

const directory=mkdtempSync(join(tmpdir(),'pdf-source-observations-'));
process.env.DATABASE_URL=':memory:';process.env.LIBRARY_DIR=directory;process.env.SERVICE_VAULT_DIR=join(directory,'vault');
process.env.AI_BUDGET_TEST_BYPASS='true';process.env.OPENAI_API_KEY='dummy-never-sent';process.env.PDF_VISUAL_TILED_INPUT='true';process.env.LOCAL_OCR='true';
after(()=>rmSync(directory,{recursive:true,force:true}));
const sha=(v:string|Uint8Array)=>createHash('sha256').update(v).digest('hex');
const png=(width:number,height:number)=>sharp({create:{width,height,channels:3,background:'white'}}).png().toBuffer();
let fixturePromise:Promise<any>|undefined;
function fixture(){return fixturePromise??=(async()=>{
 const pdf=await PDFDocument.create(),page=pdf.addPage([220,160]);page.setCropBox(10,20,200,100);page.setRotation(degrees(90));
 page.node.set(PDFName.of('UserUnit'),PDFNumber.of(2));page.drawText('Native observation',{x:20,y:80,size:10});
 page.pushOperators(pushGraphicsState(),rectangle(10,20,60,40),clip(),endPath(),popGraphicsState());
 page.drawImage(await pdf.embedPng(await png(2,2)),{x:30,y:40,width:20,height:30});
 const bytes=await pdf.save(),image=await png(200,400),images=['overview','left-top','right-top','left-bottom','right-bottom'].map(label=>observationImage(label,image,page.getCropBox())),
  binding=observationBinding(sha(bytes),1,page,images),packet=await collectPdfSourceObservations(bytes,binding);
 return {bytes,binding,packet};
})();}

test('actual existing PDF.js worker retains rotated crop/UserUnit, native items, clips and raster placements without semantic inference',async()=>{
 const {bytes,binding,packet}=await fixture();assert.equal(packet.sidecar.status,'available',packet.sidecar.reason);
 const raw=packet.sidecar.observations;assert.equal(raw.producer.version,'6.3.289');
 assert.deepEqual(raw.frame.view,[10,20,210,120]);assert.equal(raw.frame.rotation,90);assert.equal(raw.frame.userUnit,2);
 assert.deepEqual(raw.frame.viewport,{width:200,height:400,transform:[0,2,2,0,-40,-20]});
 assert.ok(raw.text.items.some((i:any)=>i.str.includes('Native observation')));assert.ok(raw.operations.some((o:any)=>o.name==='clip'));
 assert.ok(raw.operations.some((o:any)=>/^paint.*Image/.test(o.name)));assert.ok(raw.operations.some((o:any)=>o.name==='save'));
 assert.equal(packet.sidecar.binding.sourcePdfSha256,sha(bytes));assert.equal(packet.sidecar.binding.images[0].width,200);
 assert.equal(bindPdfSourceObservation(binding,{status:'available',body:raw}).sidecarSha256,packet.sidecarSha256);
 assert.ok(packet.sidecar.limitations.some((s:string)=>s.includes('not original PDF syntax')));
 assert.equal(raw.nodes,undefined);assert.equal(raw.edges,undefined);
 await assert.rejects(collectPdfSourceObservations(bytes,{...binding,sourcePdfSha256:'f'.repeat(64)}),/checksum/);
});

test('frame/producer/byte/operation failures remain unavailable without a partial successful observation',async()=>{
 const {binding,packet}=await fixture(),raw=packet.sidecar.observations;
 const bound=(body:any,b=binding)=>bindPdfSourceObservation(b,{status:'available',body});
 assert.equal(bound({...raw,producer:{name:'pdfjs-dist',version:'future'}}).sidecar.reason,'source-page-frame-mismatch');
 assert.equal(bound({...raw,physicalPage:2}).sidecar.status,'unavailable');
 const outside={...binding,sourceFrame:{...binding.sourceFrame,cropBox:{x:0,y:0,width:240,height:180}}};
 assert.equal(bound({...raw,frame:{...raw.frame,view:[0,0,220,160]}},outside).sidecar.reason,'overview-effective-crop-mismatch');
 assert.equal(bound({...raw,frame:{...raw.frame,viewport:{...raw.frame.viewport,transform:[0,2,2,0,0,0]}}}).sidecar.reason,'unsupported-viewport');
 for(const rotation of [0,180,270]){
  const frame={...raw.frame,rotation,viewport:rotation===0?{width:400,height:200,transform:[2,0,0,-2,-20,240]}:
   rotation===180?{width:400,height:200,transform:[-2,0,0,2,420,-40]}:{width:200,height:400,transform:[0,-2,-2,0,240,420]}},
   b={...binding,sourceFrame:{...binding.sourceFrame,rotation},images:binding.images.map((i:any)=>({...i,width:frame.viewport.width,height:frame.viewport.height}))};
  assert.equal(bound({...raw,frame},b).sidecar.status,'available');
 }
 const oversized=bound({...raw,extra:'x'.repeat(PDF_SOURCE_OBSERVATION_LIMITS.bytes)});
 assert.equal(oversized.sidecar.status,'unavailable');assert.equal(oversized.sidecar.reason,'sidecar-byte-limit');assert.equal(oversized.sidecar.observations,undefined);
 assert.equal(bound({...raw,operations:Array.from({length:10001},(_,index)=>({index,name:'save',args:null}))}).sidecar.status,'unavailable');
 const timeout=bindPdfSourceObservation(binding,{status:'unavailable',reason:'observation-timeout'});
 assert.equal(timeout.sidecar.status,'unavailable');assert.equal(timeout.sidecar.reason,'observation-timeout');assert.equal(timeout.sidecar.observations,undefined);
 const body=encodeSourceObservationCache(timeout,'a'.repeat(64),'Unchanged text.');
 assert.equal(readSourceObservationCache(body,timeout,'a'.repeat(64)),'Unchanged text.');
 assert.throws(()=>readSourceObservationCache(body,packet,'a'.repeat(64)),/identity/);
 assert.throws(()=>readSourceObservationCache(body,timeout,'b'.repeat(64)),/identity/);
});

test('formal opt-in wire binds actual observations and five unchanged PNGs in its own cache; defaults remain plaintext',async()=>{
 const savedExec=childProcess.execFile,savedFetch=globalThis.fetch,pdf=await PDFDocument.create();pdf.addPage([200,200]).drawText('Original source');
 const bytes=await pdf.save(),image=await png(2,2),requests:any[]=[];
 childProcess.execFile=((binary:string,args:string[],_options:unknown,callback:(error:Error|null,stdout?:string,stderr?:string)=>void)=>{
  assert.equal(binary,'pdftoppm');void writeFile(args[7]+'.png',image).then(()=>callback(null,'',''),e=>callback(e));return {};
 }) as unknown as typeof childProcess.execFile;syncBuiltinESMExports();
 try{
  const {transcribePdfVisualPages,selectedVisualPageCacheParser}=await import('../lib/document-parser.ts'),{database:db}=await import('../lib/database.ts');
  const options={pageNumbers:[1],expectedSourceHash:sha(bytes),model:'gpt-5.4-mini',imageInput:true,overviewImage:true};
  globalThis.fetch=async(_url,init)=>{requests.push(JSON.parse(String(init?.body)));return Response.json({status:'completed',model:'gpt-5.4-mini-2026-03-17',
   output_text:JSON.stringify({text:'Original unchanged text.',complete:true,uncertain_spans:[]})});};
  await transcribePdfVisualPages('formal-observation',bytes,options);
  await transcribePdfVisualPages('formal-observation',bytes,{...options,fidelityProfile:'source-observation-v1'});
  const [oldBody,newBody]=requests,oldContent=oldBody.input[0].content,newContent=newBody.input[0].content;
  assert.equal(requests.length,2);assert.deepEqual(oldBody.reasoning,{effort:'low'});assert.deepEqual(newBody.reasoning,{effort:'medium'});
  assert.equal(newBody.max_output_tokens,9000);assert.deepEqual(newBody.text,oldBody.text);assert.equal(oldContent.length,11);assert.equal(newContent.length,12);
  assert.deepEqual(newContent.slice(1,11),oldContent.slice(1));assert.ok(newContent[0].text.startsWith(oldContent[0].text));
  const observations=JSON.parse(newContent[11].text.slice(newContent[11].text.indexOf('\n')+1));
  assert.equal(observations.sidecar.status,'available');assert.equal(observations.sidecar.binding.sourcePdfSha256,sha(bytes));
  assert.equal(observations.sidecar.binding.images.length,5);assert.equal(observations.sidecarSha256,sha(observationJson(observations.sidecar)));
  assert.equal(observations.sidecar.binding.images[0].sha256,sha(image));
  const cacheKey=selectedVisualPageCacheParser(sha(bytes),options.model,true,true,true,'source-observation-v1',observations.sidecarSha256);
  assert.notEqual(cacheKey,selectedVisualPageCacheParser(sha(bytes),options.model,true,true,true,'structure-v1'));
  const cached=await db.prepare('SELECT body FROM library_parse_pages WHERE document_id=? AND parser=?').bind('formal-observation',cacheKey).first<{body:string}>();
  assert.ok(cached);const cache=JSON.parse(cached.body);assert.equal(cache.requestSha256,sha(JSON.stringify(newBody)));
  assert.deepEqual(cache.sidecar,observations.sidecar);assert.ok(!cached.body.includes('base64'));
  await transcribePdfVisualPages('formal-observation',bytes,{...options,fidelityProfile:'source-observation-v1'});
  await transcribePdfVisualPages('formal-observation',bytes,options);assert.equal(requests.length,2);
  assert.equal((await db.prepare('SELECT body FROM library_parse_pages WHERE document_id=? AND parser=?').bind('formal-observation',
   selectedVisualPageCacheParser(sha(bytes),options.model,true,true,true)).first<{body:string}>())?.body,'Original unchanged text.');
 }finally{globalThis.fetch=savedFetch;childProcess.execFile=savedExec;syncBuiltinESMExports();}
});

test('invalid profile and failed/control-bearing new responses never publish or silently clean text',async()=>{
 const savedExec=childProcess.execFile,savedFetch=globalThis.fetch,pdf=await PDFDocument.create();pdf.addPage([200,200]);const bytes=await pdf.save(),image=await png(2,2);
 let requests=0,mode='failed',lastBody:any;
 childProcess.execFile=((_binary:string,args:string[],_options:unknown,callback:(error:Error|null,stdout?:string,stderr?:string)=>void)=>{
  void writeFile(args[7]+'.png',image).then(()=>callback(null,'',''),e=>callback(e));return {};
 }) as unknown as typeof childProcess.execFile;syncBuiltinESMExports();
 try{
  const {transcribePdfVisualPages}=await import('../lib/document-parser.ts'),{database:db}=await import('../lib/database.ts');
  const options={pageNumbers:[1],model:'gpt-5.4-mini',imageInput:true,overviewImage:true,fidelityProfile:'source-observation-v1' as const};
  globalThis.fetch=async(_url,init)=>{requests++;lastBody=JSON.parse(String(init?.body));return Response.json({status:mode==='failed'?'failed':'completed',error:mode==='failed'?{message:'failed'}:undefined,
   model:mode==='unknown-model'?'gpt-other-2026-03-17':'gpt-5.4-mini-2026-03-17',
   output_text:JSON.stringify({text:mode==='control'?'Do not clean\u0007':'Original text.',complete:true,uncertain_spans:[]})});};
  for(const invalid of [{...options,fidelityProfile:'future' as never},{...options,overviewImage:false},{...options,model:'gpt-5-mini'}])
   await assert.rejects(transcribePdfVisualPages('invalid-observation',bytes,invalid),/配置|总览/);
  assert.equal(requests,0);await assert.rejects(transcribePdfVisualPages('failed-observation',bytes,options),/不完整/);
  mode='unknown-model';await assert.rejects(transcribePdfVisualPages('unknown-model-observation',bytes,options),/模型身份未知/);
  mode='control';await assert.rejects(transcribePdfVisualPages('control-observation',bytes,options),/控制字符 U\+0007/);
  assert.equal(requests,3);assert.equal(await db.prepare('SELECT 1 FROM library_parse_pages WHERE document_id IN (?,?,?)').bind('failed-observation','unknown-model-observation','control-observation').first(),null);
  const outside=await PDFDocument.create();outside.addPage([200,200]).setCropBox(-10,-10,220,220);mode='success';
  await transcribePdfVisualPages('unavailable-observation',await outside.save(),options);
  const wireObservation=JSON.parse(lastBody.input[0].content.at(-1).text.split('\n').slice(1).join('\n'));
  assert.equal(wireObservation.sidecar.status,'unavailable');assert.equal(wireObservation.sidecar.reason,'overview-effective-crop-mismatch');
  const stored=await db.prepare('SELECT body FROM library_parse_pages WHERE document_id=?').bind('unavailable-observation').first<{body:string}>();
  assert.deepEqual(JSON.parse(stored!.body).sidecar,wireObservation.sidecar,'unavailable is genuine wire/cache state, not silent empty success');
 }finally{globalThis.fetch=savedFetch;childProcess.execFile=savedExec;syncBuiltinESMExports();}
});
