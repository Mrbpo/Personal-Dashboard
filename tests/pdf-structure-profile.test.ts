import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PDFDocument} from 'pdf-lib';

const directory=mkdtempSync(join(tmpdir(),'pdf-structure-profile-'));
process.env.DATABASE_URL=':memory:';process.env.LIBRARY_DIR=directory;process.env.SERVICE_VAULT_DIR=join(directory,'vault');
process.env.AI_BUDGET_TEST_BYPASS='true';process.env.OPENAI_API_KEY='dummy-never-sent';process.env.PDF_VISUAL_TILED_INPUT='true';process.env.LOCAL_OCR='true';
after(()=>rmSync(directory,{recursive:true,force:true}));
const sha=(v:string|Uint8Array)=>createHash('sha256').update(v).digest('hex'),png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP8zwACTGCSAQANHQEDgslx/wAAAABJRU5ErkJggg==','base64');

test('structure profile isolates medium request/cache, preserves default five-image wire, rejects unsupported config and never cleans controls',async()=>{
 const savedExec=childProcess.execFile,savedFetch=globalThis.fetch,pdf=await PDFDocument.create();pdf.addPage([200,300]);
 const bytes=await pdf.save(),sourceHash=sha(bytes),requests:any[]=[];let renders=0,controlled=false;
 childProcess.execFile=((binary:string,args:string[],_options:unknown,callback:(error:Error|null,stdout?:string,stderr?:string)=>void)=>{
  if(binary==='tesseract'){callback(Error('OCR unavailable in render-only fixture'));return {};}
  assert.equal(binary,'pdftoppm');renders++;void writeFile(args[7]+'.png',png).then(()=>callback(null,'',''),e=>callback(e));return {};
 }) as unknown as typeof childProcess.execFile;syncBuiltinESMExports();
 try{
  const {transcribePdfVisualPages,selectedVisualPageCacheParser}=await import('../lib/document-parser.ts'),{database:db}=await import('../lib/database.ts');
  const options={pageNumbers:[1],expectedSourceHash:sourceHash,model:'gpt-5.4-mini',imageInput:true,overviewImage:true},
   oldKey=selectedVisualPageCacheParser(sourceHash,options.model,true,true,true),newKey=selectedVisualPageCacheParser(sourceHash,options.model,true,true,true,'structure-v1');
  assert.notEqual(oldKey,newKey);assert.equal(selectedVisualPageCacheParser(sourceHash,options.model,true,true,true,undefined),oldKey);
  globalThis.fetch=async(_url,init)=>{requests.push(JSON.parse(String(init?.body)));return Response.json({status:'completed',model:'gpt-5.4-mini-2026-03-17',
   output_text:JSON.stringify({blocks:[{kind:'text',text:controlled?'Visible bullet\u0007 remains invalid.':'Original unchanged text.'}],complete:true,uncertain_spans:[]})});};
  const original=await transcribePdfVisualPages('profile',bytes,options);
  const profiled=await transcribePdfVisualPages('profile',bytes,{...options,fidelityProfile:'structure-v1'});
  assert.equal(requests.length,2);assert.equal(renders,10);assert.deepEqual(profiled,original);
  const [oldBody,newBody]=requests;assert.deepEqual(oldBody.reasoning,{effort:'low'});assert.deepEqual(newBody.reasoning,{effort:'medium'});
  assert.equal(newBody.model,'gpt-5.4-mini');assert.equal(newBody.max_output_tokens,9000);assert.deepEqual(newBody.text,oldBody.text);
  const oldContent=oldBody.input[0].content,newContent=newBody.input[0].content;
  assert.equal(newContent.length,12);assert.deepEqual(newContent.slice(1),oldContent.slice(1));
  assert.equal(newContent.filter((p:any)=>p.type==='input_image').length,5);assert.ok(newContent[0].text.startsWith(oldContent[0].text.split('\n选页结构协议 v4')[0]));assert.ok(newContent[0].text.endsWith(oldContent[0].text.slice(oldContent[0].text.indexOf('\n选页结构协议 v4'))));
  assert.ok(!oldContent[0].text.includes('结构保真 structure-v1'));assert.ok(newContent[0].text.includes('运算符各自的上下限和完整作用范围'));
  assert.ok(newContent[0].text.includes('每条实际可见箭头的起点、终点'));assert.ok(newContent[0].text.includes('不补造隐含原子'));
  assert.equal(await db.prepare('SELECT count(*) n FROM library_parse_pages WHERE document_id=?').bind('profile').first<{n:number}>().then(r=>r?.n),2);
  await transcribePdfVisualPages('profile',bytes,{...options,fidelityProfile:'structure-v1'});await transcribePdfVisualPages('profile',bytes,options);
  assert.equal(requests.length,2);assert.equal(renders,10,'each configuration reuses only its own completed cache');
  for(const invalid of [{...options,fidelityProfile:'future' as never},{...options,fidelityProfile:'structure-v1' as const,model:'gpt-5-mini'},
   {...options,fidelityProfile:'structure-v1' as const,overviewImage:false},{...options,fidelityProfile:'structure-v1' as const,pageNumbers:undefined},
   {...options,fidelityProfile:'structure-v1' as const,imageInput:false}])await assert.rejects(transcribePdfVisualPages('invalid',bytes,invalid),/配置|总览/);
  assert.equal(requests.length,2);assert.equal(renders,10,'unsupported profiles fail before rendering or provider');
  controlled=true;await assert.rejects(transcribePdfVisualPages('control-reject',bytes,{...options,fidelityProfile:'structure-v1'}),/控制字符 U\+0007/);
  assert.equal(requests.length,3);assert.equal(await db.prepare('SELECT 1 FROM library_parse_pages WHERE document_id=?').bind('control-reject').first(),null);
 }finally{globalThis.fetch=savedFetch;childProcess.execFile=savedExec;syncBuiltinESMExports();}
});
