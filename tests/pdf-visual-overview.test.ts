import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PDFDocument,PDFArray,PDFRawStream,degrees,rgb,type PDFPage} from 'pdf-lib';
import {encodeVisualBlockCache} from '../lib/pdf-visual-blocks.ts';

const directory=mkdtempSync(join(tmpdir(),'pdf-overview-tests-'));
process.env.DATABASE_URL=':memory:';
process.env.LIBRARY_DIR=directory;
process.env.SERVICE_VAULT_DIR=join(directory,'vault');
process.env.AI_BUDGET_TEST_BYPASS='true';
process.env.OPENAI_API_KEY='dummy-key-never-sent';
process.env.PDF_VISUAL_TILED_INPUT='true';
process.env.LOCAL_OCR='true';
after(()=>rmSync(directory,{recursive:true,force:true}));
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP8zwACTGCSAQANHQEDgslx/wAAAABJRU5ErkJggg==','base64');
const streamHashes=(page:PDFPage)=>{
 const contents=page.node.Contents(),streams=contents instanceof PDFArray?contents.asArray().map(ref=>page.doc.context.lookup(ref)):contents?[contents]:[];
 return streams.map(stream=>{assert.ok(stream instanceof PDFRawStream);return createHash('sha256').update(stream.getContents()).digest('hex');});
};

test('optional overview binds the full original page before details, preserves old cache and fails closed before provider',async()=>{
 const originalExec=childProcess.execFile,originalFetch=globalThis.fetch;
 let renders=0,calls=0,failOverview=false;
 const boxes:Array<{x:number;y:number;width:number;height:number}>=[];
 const pdf=await PDFDocument.create();pdf.addPage([200,200]);
 const page=pdf.addPage([500,650]);page.setCropBox(10,20,400,560);page.setRotation(degrees(90));
 page.drawRectangle({x:10,y:20,width:400,height:560,color:rgb(1,0,0)});
 const bytes=await pdf.save(),sourceHash=createHash('sha256').update(bytes).digest('hex');
 const originalStreams=streamHashes((await PDFDocument.load(bytes)).getPage(1));
 childProcess.execFile=((binary:string,args:string[],_options:unknown,callback:(error:Error|null,stdout?:string,stderr?:string)=>void)=>{
  void (async()=>{
   assert.equal(binary,'pdftoppm');
   const copied=await PDFDocument.load(await readFile(args[6]));assert.equal(copied.getPageCount(),1);
   const view=copied.getPage(0);assert.equal(view.getRotation().angle,90);
   assert.deepEqual(streamHashes(view),originalStreams);
   assert.deepEqual(view.getMediaBox(),view.getCropBox());boxes.push(view.getCropBox());renders++;
   if(failOverview)throw Error('controlled full overview failure');
   await writeFile(args[7]+'.png',png);
  })().then(()=>callback(null,'',''),error=>callback(error));return {};
 }) as unknown as typeof childProcess.execFile;
 syncBuiltinESMExports();
 try{
  const {transcribePdfVisualPages,selectedVisualPageCacheParser}=await import('../lib/document-parser.ts');
  const {database:db}=await import('../lib/database.ts');
  const oldKey=selectedVisualPageCacheParser(sourceHash,'gpt-5.4-mini',true,true);
  const newKey=selectedVisualPageCacheParser(sourceHash,'gpt-5.4-mini',true,true,true);
  assert.notEqual(newKey,oldKey);
  await db.prepare('INSERT INTO library_parse_pages VALUES (?,?,?,?)').bind('overview',oldKey,1,encodeVisualBlockCache(
   {sourceHash,physicalPage:2,model:'gpt-5.4-mini',parser:oldKey},'a'.repeat(64),{status:'unavailable',image:null,reason:'fixture'},
   JSON.stringify({complete:true,uncertain_spans:[],blocks:[{kind:'text',text:'original tile-only cache'}]}))).run();
  globalThis.fetch=async(_input,init)=>{
   calls++;const request=JSON.parse(String(init?.body)),content=request.input[0].content;
   assert.equal(request.model,'gpt-5.4-mini');assert.equal(request.max_output_tokens,9000);
   assert.deepEqual(request.reasoning,{effort:'low'});assert.equal(content.length,12);
   assert.ok(content[0].text.startsWith('第一幅 PNG 是完整原始页总览'));
   const labels=['原始第 2 页：完整页面总览',...['左上','右上','左下','右下'].map(label=>`同一原始第 2 页：${label}视图`)];
   for(const [i,label] of labels.entries()){
    assert.deepEqual(content[1+i*2],{type:'input_text',text:label});
    assert.deepEqual(content[2+i*2],{type:'input_image',image_url:`data:image/png;base64,${png.toString('base64')}`,detail:'original'});
   }
   return Response.json({output_text:JSON.stringify({blocks:[{kind:'text',text:'Original full page with conditions.'}],complete:true,uncertain_spans:[]})});
  };
  const options={pageNumbers:[2],expectedSourceHash:sourceHash,model:'gpt-5.4-mini',imageInput:true,overviewImage:true};
  const result=await transcribePdfVisualPages('overview',bytes,options);
  assert.equal(result[0].text,'Original full page with conditions.');assert.equal(result[0].pageNumber,2);
  assert.equal(calls,1);assert.equal(renders,5);
  assert.deepEqual(boxes[0],{x:10,y:20,width:400,height:560},'overview contains the entire original visible CropBox');
  assert.ok(boxes.slice(1).every(box=>box.width<400&&box.height<560),'remaining views are details');
  assert.deepEqual(await transcribePdfVisualPages('overview',bytes,options),result);
  assert.equal(renders,5);assert.equal(calls,1,'same configuration reuses completed cache');
  assert.equal((await transcribePdfVisualPages('overview',bytes,{...options,overviewImage:false}))[0].text,'original tile-only cache');
  assert.equal(renders,5);assert.equal(calls,1,'old configuration retains its original cache');
  failOverview=true;
  await assert.rejects(transcribePdfVisualPages('failed-overview',bytes,options),/完整总览渲染失败/);
  assert.equal(calls,1,'a failed overview never sends the partial detail set');
  assert.equal(await db.prepare('SELECT 1 FROM library_parse_pages WHERE document_id=?').bind('failed-overview').first(),null);
  await assert.rejects(transcribePdfVisualPages('invalid-overview',bytes,{...options,imageInput:false}),/完整总览仅适用于/);
  assert.equal(calls,1);
 }finally{globalThis.fetch=originalFetch;childProcess.execFile=originalExec;syncBuiltinESMExports();}
});
