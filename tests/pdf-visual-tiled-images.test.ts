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

const directory=mkdtempSync(join(tmpdir(),'pdf-tiled-image-tests-'));
process.env.DATABASE_URL=':memory:';
process.env.LIBRARY_DIR=directory;
process.env.SERVICE_VAULT_DIR=join(directory,'vault');
process.env.AI_BUDGET_TEST_BYPASS='true';
process.env.OPENAI_API_KEY='dummy-key-never-sent';
process.env.PDF_VISUAL_TILED_INPUT='true';
process.env.LOCAL_OCR='true';
after(()=>rmSync(directory,{recursive:true,force:true}));

// Distinct valid PNG fixtures stand in for the renderer, never a real provider.
const pngs=[
 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP8zwACTGCSAQANHQEDgslx/wAAAABJRU5ErkJggg==',
 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAE0lEQVR4nGNkaGBgYGBgAhEMDAAGKgCE2O/yUgAAAABJRU5ErkJggg==',
 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGNkYPjPwMDAxAAGAAsfAQMU4wsAAAAAAElFTkSuQmCC',
 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFElEQVR4nGP8/5+BgYGBCUQwMAAAGRECAh1OODsAAAAASUVORK5CYII=',
];

test('selected tiled PNGs preserve source geometry and identity in one request, with no request on render/rotation failure',async()=>{
 const renderedBoxes:Array<{x:number;y:number;width:number;height:number}>=[];
 let renders=0,failAtRender=0,calls=0;
 const originalFetch=globalThis.fetch;
 const originalExecFile=childProcess.execFile;
 // Direct replacement also removes execFile's built-in promisify.custom hook,
 // which a proxy around the original would otherwise still execute.
 childProcess.execFile=((file:string,args:string[],_options:unknown,callback:(error:Error|null,stdout?:string,stderr?:string)=>void)=>{
  void (async()=>{
   assert.equal(file,'pdftoppm');
   assert.equal(args.length,8);
   assert.deepEqual(args.slice(0,6),['-f','1','-singlefile','-scale-to','2500','-png']);
   const copy=await PDFDocument.load(await readFile(args[6]));
   assert.equal(copy.getPageCount(),1,'each PNG is rendered from one view, not the first of a four-page PDF');
   const page=copy.getPage(0),box=page.getCropBox();
   assert.deepEqual(page.getMediaBox(),box);
   assert.equal(page.getRotation().angle,0);
   renderedBoxes.push(box);renders++;
   if(renders===failAtRender)throw new Error('controlled renderer failure');
   await writeFile(args[7]+'.png',Buffer.from(pngs[(renders-1)%4],'base64'));
  })().then(()=>callback(null,'',''),error=>callback(error));
  return {};
 }) as unknown as typeof childProcess.execFile;
 syncBuiltinESMExports();
 try{
  // Import after the builtin mock: local-ocr captures promisify(execFile).
  const {transcribePdfVisualPages,selectedVisualPageCacheParser}=await import('../lib/document-parser.ts');
  const {database:db}=await import('../lib/database.ts');
  const pdf=await PDFDocument.create();
  for(let index=0;index<30;index++)pdf.addPage([400+index,600]);
  pdf.getPage(28).setCropBox(10,20,400,560);
  const bytes=await pdf.save(),sourceHash=createHash('sha256').update(bytes).digest('hex'),id='tiled-source-page-29';
  const oldKey=(imageInput:boolean,tiled:boolean)=>'pdf-visual-selected-v3:'+createHash('sha256')
   .update(JSON.stringify({sourceHash,model:'gpt-5-mini',imageInput,tiled,promptVersion:3})).digest('hex');
  for(const [imageInput,tiled] of [[false,false],[false,true],[true,false]])
   assert.equal(selectedVisualPageCacheParser(sourceHash,'gpt-5-mini',imageInput,tiled),oldKey(imageInput,tiled),'existing reachable mode keys stay byte-compatible');
  const singleKey=oldKey(true,false),fileKey=oldKey(false,true),newKey=selectedVisualPageCacheParser(sourceHash,'gpt-5-mini',true,true);
  assert.notEqual(newKey,oldKey(true,true),'combined mode explicitly adds the crop/render/prompt identity');
  for(const [key,body] of [[singleKey,'old single image'],[fileKey,'old four-page PDF']])
   await db.prepare('INSERT INTO library_parse_pages VALUES (?,?,?,?)').bind(id,key,28,body).run();
  const originalText='Source typo competition; worksheet _____; original matrix \\(0\\).';
  globalThis.fetch=async(input,init)=>{
   calls++;
   assert.equal(String(input),'https://api.openai.com/v1/responses');
   const request=JSON.parse(String(init?.body)),content=request.input[0].content;
   assert.equal(request.model,'gpt-5-mini');assert.equal(request.max_output_tokens,9000);
   assert.deepEqual(request.reasoning,{effort:'low'});
   assert.equal(content.length,9);
   const images=content.filter((part:{type:string})=>part.type==='input_image');
   assert.equal(images.length,4);assert.equal(content.some((part:{type:string})=>part.type==='input_file'),false);
   for(const [index,label] of ['左上','右上','左下','右下'].entries()){
    assert.deepEqual(content[1+index*2],{type:'input_text',text:`同一原始第 29 页：${label}视图`});
    assert.equal(images[index].image_url,`data:image/png;base64,${pngs[index]}`);
    assert.equal(images[index].detail,'high');
   }
   return Response.json({output_text:JSON.stringify({text:originalText,complete:true,uncertain_spans:[]})});
  };
  const options={pageNumbers:[29],expectedSourceHash:sourceHash,model:'gpt-5-mini',imageInput:true};
  const result=await transcribePdfVisualPages(id,bytes,options);
  assert.deepEqual(result,[{pageNumber:29,locator:'第 29 页',text:originalText}]);
  const expectedBoxes=[{x:10,y:272,width:220,height:308},{x:190,y:272,width:220,height:308},
   {x:10,y:20,width:220,height:308},{x:190,y:20,width:220,height:308}];
  for(const [index,expected] of expectedBoxes.entries())
   for(const key of ['x','y','width','height'] as const)assert.ok(Math.abs(renderedBoxes[index][key]-expected[key])<1e-8);
  assert.equal(calls,1);assert.equal(renders,4);
  assert.deepEqual(await transcribePdfVisualPages(id,bytes,options),result);
  assert.equal(calls,1);assert.equal(renders,4,'completed same-mode cache avoids rendering and provider work');
  assert.equal((await db.prepare('SELECT body FROM library_parse_pages WHERE document_id=? AND parser=? AND page=28').bind(id,newKey).first<{body:string}>())?.body,originalText);
  process.env.PDF_VISUAL_TILED_INPUT='false';
  assert.equal((await transcribePdfVisualPages(id,bytes,options))[0].text,'old single image');
  process.env.PDF_VISUAL_TILED_INPUT='true';
  assert.equal((await transcribePdfVisualPages(id,bytes,{...options,imageInput:false}))[0].text,'old four-page PDF');
  assert.equal(calls,1);assert.equal(renders,4);

  failAtRender=renders+3;
  await assert.rejects(transcribePdfVisualPages('failed-crop',bytes,options),/左下视图渲染失败/);
  assert.equal(calls,1,'no provider request when one of the four crops fails');
  assert.equal(await db.prepare('SELECT 1 FROM library_parse_pages WHERE document_id=?').bind('failed-crop').first(),null);
  const rendersBeforeRotation=renders;
  pdf.getPage(29).setRotation(degrees(90));
  await assert.rejects(transcribePdfVisualPages('rotated-selected',await pdf.save(),{...options,pageNumbers:[29,30],expectedSourceHash:undefined}),/暂不支持旋转页面/);
  assert.equal(calls,1);assert.equal(renders,rendersBeforeRotation,'all selected rotations are checked before any earlier page can charge');
 }finally{
  globalThis.fetch=originalFetch;childProcess.execFile=originalExecFile;syncBuiltinESMExports();
 }
});
