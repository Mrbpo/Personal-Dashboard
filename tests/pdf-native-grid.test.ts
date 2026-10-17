import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {mkdtempSync,rmSync} from 'node:fs';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {PDFDocument,PDFName,PDFNumber,degrees} from 'pdf-lib';
import {validatePdfNativeGridObservation,assertPdfNativeGridImage,nativeGridResponseSchema,nativeGridInputText,nativeGridCacheParser,derivePdfNativeGridPage,encodePdfNativeGridCache,readPdfNativeGridCache,PDF_NATIVE_GRID_PROMPT,type PdfNativeGridObservation} from '../lib/pdf-native-grid.ts';
import {VISUAL_BLOCK_SCHEMA,VISUAL_BLOCK_PROMPT} from '../lib/pdf-visual-blocks.ts';
const sha=(b:string|Uint8Array)=>createHash('sha256').update(b).digest('hex');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP8zwACTGCSAQANHQEDgslx/wAAAABJRU5ErkJggg==','base64');
const clone=<T>(v:T):T=>JSON.parse(JSON.stringify(v));
function signed(v:PdfNativeGridObservation){const {sidecarSha256,...rest}=v;return {...rest,sidecarSha256:sha(JSON.stringify(rest))};}
function observation(sourceHash='a'.repeat(64)):PdfNativeGridObservation{
 const body=JSON.stringify({producer:'synthetic-observation',text:'Untrusted covered text remains raw',drawings:[]});
 return signed({version:'pdf-native-grid-v1',sourceHash,physicalPage:1,frame:{rect:[0,0,100,100],mediaBox:[0,0,100,100],cropBox:[0,0,100,100],rotation:0},image:{sha256:sha(png),width:2,height:2},
  producer:{name:'synthetic-bound-fixture',version:'1',policy:'physical-candidates-not-visibility'},nativeObservationSha256:'b'.repeat(64),
  grids:[{id:'gridA',bbox:[10,20,90,80],rowCount:1,columnCount:2,cells:[{id:'cellA',row:0,column:0,rowSpan:1,columnSpan:1,bbox:[10,20,50,80]},{id:'cellB',row:0,column:1,rowSpan:1,columnSpan:1,bbox:[50,20,90,80]}]}],
  observations:{body,sha256:sha(body)},sidecarSha256:''});
}
const raw=()=>JSON.stringify({complete:true,uncertain_spans:[],blocks:[{kind:'text',text:'Outside heading: Measure; Part. Association is a candidate.'},
 {kind:'gridRef',gridId:'gridA',status:'table',columnLabels:{status:'observed',labels:[{fromColumnId:'c0',toColumnId:'c1',text:'Measure'},{fromColumnId:'c1',toColumnId:'c1',text:'Part'}]},cells:[{cellId:'cellB',text:'',contentStatus:'blank',bold:'none'},{cellId:'cellA',text:String.raw`\(z_{i}^{2}\)`,contentStatus:'legible',bold:'all'}]},
 {kind:'text',text:'Caption after the grid.'}]});
const unavailable={status:'unavailable' as const,image:null,reason:'local-ocr-disabled'};

test('source-bound sidecar validates exact bytes, physical slots/boundaries and schema capacity without guessed geometry',()=>{
 const o=observation(),expected={sourceHash:o.sourceHash,physicalPage:1,frame:o.frame};assert.equal(validatePdfNativeGridObservation(o,expected),o);assertPdfNativeGridImage(o,png);
 const before=JSON.stringify(o);assert.ok(JSON.stringify(nativeGridResponseSchema(o)).includes('cellA'));assert.equal(JSON.stringify(o),before);
 assert.throws(()=>validatePdfNativeGridObservation(o,{...expected,sourceHash:'c'.repeat(64)}),/source\/frame/);
 for(const change of [(v:PdfNativeGridObservation)=>{v.frame.rotation=90;},(v:PdfNativeGridObservation)=>{v.grids[0].cells[1].column=0;},
  (v:PdfNativeGridObservation)=>{v.grids[0].cells[1].bbox[0]=49;},(v:PdfNativeGridObservation)=>{v.grids[0].cells.pop();},
  (v:PdfNativeGridObservation)=>{v.observations.body=JSON.stringify({x:'π'.repeat(100001)});v.observations.sha256=sha(v.observations.body);}]){
  const v=clone(o);change(v);assert.throws(()=>validatePdfNativeGridObservation(signed(v)),/Invalid native grid/);
 }
 const edited=clone(o);edited.producer.policy='different actual policy';assert.throws(()=>validatePdfNativeGridObservation(edited),/sidecar identity/);
 const changed=signed(edited);assert.notEqual(nativeGridCacheParser('old-base',o),nativeGridCacheParser('old-base',changed));
 const tooMany=clone(o);tooMany.grids[0]={id:'many',bbox:[0,0,100,100],rowCount:100,columnCount:10,cells:Array.from({length:1000},(_,i)=>({id:'cell'+i,row:Math.floor(i/10),column:i%10,rowSpan:1,columnSpan:1,bbox:[i%10*10,Math.floor(i/10),(i%10+1)*10,Math.floor(i/10)+1]}))};
 assert.throws(()=>validatePdfNativeGridObservation(signed(tooMany)),/schema capacity/);
 assert.throws(()=>assertPdfNativeGridImage(o,Buffer.from('wrong')),/PNG mismatch/);
});

test('grid-reference output only fills frozen cells, keeps page text/math and refuses unknown, missing or uncertain content',()=>{
 const o=observation(),before=JSON.stringify(o),result=derivePdfNativeGridPage(raw(),o),table=result.content.blocks[1] as any;
 assert.equal(table.rowCount,1);assert.equal(table.columnCount,2);assert.deepEqual(table.cells.map((c:any)=>[c.row,c.column,c.headerRole,c.text]),[[0,0,'none',String.raw`\(z_{i}^{2}\)`],[0,1,'none','']]);
 assert.ok(result.searchText.indexOf('Outside heading')<result.searchText.indexOf('Physical cell cellA'));assert.ok(result.searchText.endsWith('Caption after the grid.'));
 assert.ok(result.searchText.includes('header/group associations=unassessed'));assert.ok(!result.searchText.includes('complete=true'));assert.ok(result.searchText.includes(String.raw`\(z_{i}^{2}\)`));
 assert.equal(result.columnLabelObservations[0].provenance,'ai-derived-unverified');assert.equal(result.columnLabelObservations[0].labels[0].fromColumnId,'c0');
 assert.ok(result.searchText.includes('c0..c1; no inferred hierarchy'));assert.equal(table.cells.length,2,'header observations never add source cells or a fake header row');
 for(const status of ['none','uncertain']){const v=JSON.parse(raw());v.blocks[1].columnLabels={status,labels:[]};const d=derivePdfNativeGridPage(JSON.stringify(v),o);assert.ok(d.searchText.includes(status==='none'?'model-asserted-none':'status=uncertain'));assert.equal(d.semanticTableVerified,false);}
 assert.equal(result.semanticTableVerified,false);assert.equal(result.visibilityVerified,false);assert.equal(JSON.stringify(o),before);
 for(const mutate of [(v:any)=>{v.blocks[1].rowCount=77;},(v:any)=>{v.blocks[1].cells[0].cellId='unknown';},(v:any)=>{v.blocks[1].cells[0].cellId='cellA';},
  (v:any)=>{v.blocks[1].cells.pop();},(v:any)=>{v.blocks.splice(1,1);},(v:any)=>{v.blocks.push(v.blocks[1]);},(v:any)=>{v.blocks[1].status='uncertain';},
  (v:any)=>{v.blocks[1].status='not-table';},(v:any)=>{v.blocks[1].cells[0].contentStatus='uncertain';},(v:any)=>{v.blocks[1].cells[0].text='not blank';},
  (v:any)=>{v.blocks[1].cells[1].text='x\u0007';},(v:any)=>{v.blocks[1].cells[1].text=String.raw`\(x_{i}`;},
  (v:any)=>{v.blocks[1].columnLabels.labels=[];},(v:any)=>{v.blocks[1].columnLabels.labels[0].toColumnId='c9';},
  (v:any)=>{v.blocks[1].columnLabels.labels[0].fromColumnId='c1';v.blocks[1].columnLabels.labels[0].toColumnId='c0';},(v:any)=>{v.blocks[1].columnLabels.labels[0].text='x\u0007';}]){
  const v=JSON.parse(raw());mutate(v);assert.throws(()=>derivePdfNativeGridPage(JSON.stringify(v),o),/Invalid native grid|Invalid visual blocks/);
 }
});

test('new cache preserves original gridRef raw and independently rederives content instead of trusting hashes or old v4',()=>{
 const o=observation(),parser=nativeGridCacheParser('selected-v4',o),binding={sourceHash:o.sourceHash,physicalPage:1,model:'gpt-5.4-mini',parser},request='c'.repeat(64);
 const body=encodePdfNativeGridCache(binding,o,request,unavailable,raw());assert.equal(JSON.parse(body).rawOutput,raw());
 assert.deepEqual(readPdfNativeGridCache(body,binding,o,request),derivePdfNativeGridPage(raw(),o));
 assert.throws(()=>readPdfNativeGridCache(body,binding,o,'d'.repeat(64)),/cache identity/);
 assert.throws(()=>readPdfNativeGridCache(body,{...binding,physicalPage:2},o,request),/cache identity/);
 const changed=JSON.parse(body);changed.derivation.searchText='forged';const {artifactSha256,...artifact}=changed;changed.artifactSha256=sha(JSON.stringify(artifact));
 assert.throws(()=>readPdfNativeGridCache(JSON.stringify(changed),binding,o,request),/cache derivation/);
 assert.throws(()=>readPdfNativeGridCache(JSON.stringify({version:'pdf-visual-blocks-v1'}),binding,o,request),/cache identity/);
 assert.throws(()=>encodePdfNativeGridCache({...binding,sourceHash:'f'.repeat(64)},o,request,unavailable,raw()),/source identity/);
});

const directory=mkdtempSync(join(tmpdir(),'pdf-native-grid-'));
process.env.DATABASE_URL=':memory:';process.env.LIBRARY_DIR=directory;process.env.SERVICE_VAULT_DIR=join(directory,'vault');
process.env.OPENAI_API_KEY='dummy-never-sent';process.env.AI_BUDGET_TEST_BYPASS='true';process.env.LOCAL_OCR='true';process.env.PDF_VISUAL_TILED_INPUT='true';
after(()=>rmSync(directory,{recursive:true,force:true}));
async function withMocks(run:(requests:any[],render:()=>number)=>Promise<void>){
 const oldExec=childProcess.execFile,oldFetch=globalThis.fetch,requests:any[]=[];let renders=0;
 childProcess.execFile=((binary:string,args:string[],_opts:unknown,callback:(error:Error|null,stdout?:string,stderr?:string)=>void)=>{
  if(binary==='tesseract'){callback(Error('Synthetic OCR unavailable'));return {};}
  assert.equal(binary,'pdftoppm');renders++;void writeFile(args[7]+'.png',png).then(()=>callback(null,'',''),e=>callback(e));return {};
 }) as unknown as typeof childProcess.execFile;syncBuiltinESMExports();
 globalThis.fetch=async(_url,init)=>{const request=JSON.parse(String(init?.body));requests.push(request);return Response.json({status:'completed',model:'gpt-5.4-mini-2026-03-17',output_text:request.text.format.name==='visual_native_grid_cells'?raw():JSON.stringify({complete:true,uncertain_spans:[],blocks:[{kind:'text',text:'Old selected path.'}]})});};
 try{await run(requests,()=>renders);}finally{childProcess.execFile=oldExec;globalThis.fetch=oldFetch;syncBuiltinESMExports();}
}

test('formal opt-in keeps the five PNGs/OCR and whole-page text, isolates old requests/cache and binds actual new raw/schema',async()=>withMocks(async(requests,renders)=>{
 const {transcribePdfVisualPages,selectedVisualPageCacheParser}=await import('../lib/document-parser.ts'),{database:db}=await import('../lib/database.ts');
 const pdf=await PDFDocument.create();pdf.addPage([100,100]);const bytes=await pdf.save(),o=observation(sha(bytes)),options={pageNumbers:[1],expectedSourceHash:sha(bytes),model:'gpt-5.4-mini',imageInput:true,overviewImage:true};
 await transcribePdfVisualPages('native-grid-formal',bytes,options);const result=await transcribePdfVisualPages('native-grid-formal',bytes,{...options,nativeGridObservations:[o]});
 const [oldWire,newWire]=requests,oldParts=oldWire.input[0].content,parts=newWire.input[0].content;assert.equal(requests.length,2);assert.equal(parts.length,13);assert.equal(parts.filter((p:any)=>p.type==='input_image').length,5);
 assert.deepEqual(parts.slice(1,11),oldParts.slice(1,11));assert.deepEqual(parts[12],oldParts[11]);assert.equal(parts[11].text,nativeGridInputText(o));
 assert.equal(parts[0].text,oldParts[0].text.slice(0,-VISUAL_BLOCK_PROMPT.length)+PDF_NATIVE_GRID_PROMPT);assert.deepEqual(oldWire.text.format.schema,VISUAL_BLOCK_SCHEMA);
 assert.deepEqual(newWire.text.format.schema,nativeGridResponseSchema(o));assert.deepEqual(newWire.reasoning,{effort:'low'});assert.equal(newWire.max_output_tokens,9000);
 const base=selectedVisualPageCacheParser(o.sourceHash,options.model,true,true,true),key=nativeGridCacheParser(base,o);assert.notEqual(key,base);
 const stored=(await db.prepare('SELECT body FROM library_parse_pages WHERE document_id=? AND parser=?').bind('native-grid-formal',key).first<{body:string}>())!;
 const cache=JSON.parse(stored.body);assert.equal(cache.requestSha256,sha(JSON.stringify(newWire)));assert.equal(cache.rawOutput,raw());assert.deepEqual(cache.sidecar,o);assert.ok(!stored.body.includes('base64'));
 assert.equal(result[0].text,cache.derivation.searchText);assert.equal(renders(),10);
 assert.deepEqual(await transcribePdfVisualPages('native-grid-formal',bytes,{...options,nativeGridObservations:[o]}),result);assert.equal(requests.length,2);
 await transcribePdfVisualPages('native-grid-formal',bytes,options);assert.equal(requests.length,2);
 const corrupted=JSON.parse(stored.body);corrupted.derivation.content.blocks[0].text='changed';const {artifactSha256,...artifact}=corrupted;corrupted.artifactSha256=sha(JSON.stringify(artifact));
 await db.prepare('UPDATE library_parse_pages SET body=? WHERE document_id=? AND parser=?').bind(JSON.stringify(corrupted),'native-grid-formal',key).run();
 await assert.rejects(transcribePdfVisualPages('native-grid-formal',bytes,{...options,nativeGridObservations:[o]}),/cache derivation/);assert.equal(requests.length,2);
}));

test('formal native route refuses invalid source/frame/image before payment and unknown model/noncompleted/uncertain responses before cache',async()=>withMocks(async(requests)=>{
 const {transcribePdfVisualPages}=await import('../lib/document-parser.ts'),{database:db}=await import('../lib/database.ts');
 const pdf=await PDFDocument.create();pdf.addPage([100,100]);const bytes=await pdf.save(),o=observation(sha(bytes)),options={pageNumbers:[1],model:'gpt-5.4-mini',imageInput:true,overviewImage:true,nativeGridObservations:[o]};
 for(const opts of [{...options,pageNumbers:undefined},{...options,overviewImage:false},{...options,model:'gpt-5-mini'},{...options,fidelityProfile:'source-observation-v1' as const},{...options,nativeGridObservations:[]}])await assert.rejects(transcribePdfVisualPages('invalid-native',bytes,opts),/原生格|总览|配置/);
 const wrong=clone(o);wrong.sourceHash='c'.repeat(64);await assert.rejects(transcribePdfVisualPages('wrong-source-native',bytes,{...options,nativeGridObservations:[signed(wrong)]}),/source\/frame/);
 const wrongImage=clone(o);wrongImage.image.sha256='c'.repeat(64);await assert.rejects(transcribePdfVisualPages('wrong-image-native',bytes,{...options,nativeGridObservations:[signed(wrongImage)]}),/PNG mismatch/);
 for(const mutation of [(p:any)=>p.setRotation(degrees(90)),(p:any)=>p.setCropBox(1,0,99,100),(p:any)=>p.node.set(PDFName.of('UserUnit'),PDFNumber.of(2))]){
  const p=await PDFDocument.create(),page=p.addPage([100,100]);mutation(page);const b=await p.save();await assert.rejects(transcribePdfVisualPages('wrong-frame-native',b,{...options,nativeGridObservations:[observation(sha(b))]}),/source\/frame|UserUnit/);
 }assert.equal(requests.length,0);
 for(const mode of ['model','status','uncertain']){
  globalThis.fetch=async()=>{requests.push(mode);const v=JSON.parse(raw());if(mode==='uncertain')v.blocks[1].cells[0].contentStatus='uncertain';return Response.json({status:mode==='status'?'failed':'completed',model:mode==='model'?'other-model':'gpt-5.4-mini-2026-03-17',output_text:JSON.stringify(v)});};
  await assert.rejects(transcribePdfVisualPages('failed-native-'+mode,bytes,options),/模型身份未知|不完整|uncertain/);
  assert.equal(await db.prepare('SELECT 1 FROM library_parse_pages WHERE document_id=?').bind('failed-native-'+mode).first(),null);
 }assert.equal(requests.length,3);
}));
