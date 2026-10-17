import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {promisify} from 'node:util';
import {mkdtempSync,rmSync} from 'node:fs';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {PDFDocument} from 'pdf-lib';
import {validateVisualPageContent,visualPageSearchText,visualTableHtml,encodeVisualBlockCache,readVisualBlockCache,
 VISUAL_BLOCK_SCHEMA,type VisualTableCell,type VisualTableBlock,type VisualPageContent} from '../lib/pdf-visual-blocks.ts';

const sha=(v:string|Uint8Array)=>createHash('sha256').update(v).digest('hex');
const cell=(row:number,column:number,text:string,extra:Partial<VisualTableCell>={}):VisualTableCell=>
 ({row,column,rowSpan:1,columnSpan:1,headerRole:'none',text,bold:'none',...extra});
const table=():VisualTableBlock=>({kind:'table',rowCount:4,columnCount:3,cells:[
 cell(0,0,'',{rowSpan:2}),cell(0,1,'Score',{headerRole:'column',columnSpan:2}),
 cell(1,1,'First',{headerRole:'column'}),cell(1,2,'Second',{headerRole:'column',bold:'all'}),
 cell(2,0,'System α',{headerRole:'row'}),cell(2,1,'12.5%'),cell(2,2,'7'),
 cell(3,0,'System β',{headerRole:'row'}),cell(3,1,'3'),cell(3,2,'<5 & "quoted"') ]});
const page=():VisualPageContent=>({complete:true,uncertain_spans:[],blocks:[{kind:'text',text:'Before \\(x=1\\)'},table(),{kind:'text',text:'Original caption below table.'},{kind:'text',text:'After \\[y=2\\]'}]});
const binding={sourceHash:'a'.repeat(64),physicalPage:2,model:'gpt-5.4-mini',parser:'pdf-visual-selected-v4:test'};
const unavailable={status:'unavailable' as const,image:null,reason:'local-ocr-disabled'};

test('ordered blocks keep full column-header paths, row labels, literal values and explicit HTML weight',()=>{
 const value=page(),original=JSON.stringify(value),text=visualPageSearchText(value),html=visualTableHtml(value.blocks[1] as VisualTableBlock);
 assert.ok(text.indexOf('Before')<text.indexOf('Cell (row')&&text.indexOf('Cell (row')<text.indexOf('Original caption below table.')&&text.indexOf('Original caption below table.')<text.indexOf('After'));
 assert.ok(text.includes('Row label [UTF-8 bytes=9]\nSystem α'));assert.match(text,/Column label \[UTF-8 bytes=5\]\nScore[\s\S]*Column label \[UTF-8 bytes=5\]\nFirst[\s\S]*Value \[UTF-8 bytes=5\]\n12\.5%/);
 assert.match(text,/Column label \[UTF-8 bytes=6\]\nSecond[\s\S]*Value \[UTF-8 bytes=1\]\n7/);assert.match(html,/colspan="2"/);
 assert.match(html,/<th[^>]*font-weight: normal[^>]*>Score<\/th>/);assert.match(html,/<th[^>]*font-weight: bold[^>]*>Second<\/th>/);
 assert.ok(html.includes('12.5%'));assert.ok(html.includes('&lt;5 &amp; &quot;quoted&quot;'));
 assert.equal(JSON.stringify(value),original,'validation and serialization never change the source grid');
});

test('invalid geometry fails without filling, merging or collecting unbounded overlap diagnostics',()=>{
 for(const mutation of [(t:VisualTableBlock)=>t.cells.pop(),(t:VisualTableBlock)=>t.cells.push({...t.cells[0]}),
  (t:VisualTableBlock)=>{t.cells[2].columnSpan=5;},(t:VisualTableBlock)=>{t.cells[2].rowSpan=0;}]){
  const t=table();mutation(t);const before=JSON.stringify(t);
  assert.throws(()=>validateVisualPageContent({complete:true,uncertain_spans:[],blocks:[t]}),/Invalid visual blocks/);
  assert.equal(JSON.stringify(t),before);
 }
 const t:VisualTableBlock={kind:'table',rowCount:100,columnCount:64,cells:Array.from({length:2048},()=>cell(0,0,'',{rowSpan:100,columnSpan:64}))};
 assert.throws(()=>validateVisualPageContent({complete:true,uncertain_spans:[],blocks:[t]}),/^Error: Invalid visual blocks: overlapping cells$/);
});

test('ambiguous section headers retain geometry, math and unresolved paths; bold is independent of role',()=>{
 const t=table();t.cells[1].headerRole='section';t.cells[1].bold='mixed';const math=String.raw`\(u_i+\alpha\)`;t.cells[5].text=math;
 const value:VisualPageContent={complete:true,uncertain_spans:[],blocks:[t,{kind:'text',text:'Caption remains after the table.'}]},before=JSON.stringify(value),text=visualPageSearchText(value);
 assert.match(text,/Header \(section; row 0; column 1; span 1x2; bold=mixed\)\nHeader text \[UTF-8 bytes=5\]\nScore/);
 assert.match(text,/Column header path \(column 1; complete=false\)[\s\S]*Column label \[UTF-8 bytes=5\]\nFirst[\s\S]*Unresolved section candidate \(row 0; column 1; span 1x2; bold=mixed/);
 assert.ok(text.includes('character-level bold positions are not encoded'));assert.ok(text.includes('Cell (row 2; column 1; span 1x1; bold=none)'));
 const frame=`Value [UTF-8 bytes=${Buffer.byteLength(math)}]\n`,offset=text.indexOf(frame)+frame.length;
 assert.ok(text.includes(math));assert.equal(Buffer.from(text.slice(offset)).subarray(0,Buffer.byteLength(math)).toString('utf8'),math,'length-framed search value reverses to original single-backslash math');
 assert.ok(text.endsWith('Caption remains after the table.'));
 assert.equal(JSON.stringify(value),before,'a section observation is never relabeled to column');
});

test('repeated column headers separated by data or crossing spans never become a complete ancestor chain',()=>{
 const repeated:VisualTableBlock={kind:'table',rowCount:4,columnCount:1,cells:[
  cell(0,0,'Earlier',{headerRole:'column'}),cell(1,0,'a'),cell(2,0,'Later',{headerRole:'column'}),cell(3,0,'b')]};
 const crossed:VisualTableBlock={kind:'table',rowCount:3,columnCount:3,cells:[
  cell(0,0,'Upper',{headerRole:'column',columnSpan:2}),cell(0,2,''),cell(1,0,''),
  cell(1,1,'Lower',{headerRole:'column',columnSpan:2}),cell(2,0,'x'),cell(2,1,'y'),cell(2,2,'z')]};
 for(const [t,reason,labels] of [[repeated,'intervening data',['Earlier','Later']],[crossed,'non-containing spans',['Upper','Lower']]] as const){
  const before=JSON.stringify(t),text=visualPageSearchText({complete:true,uncertain_spans:[],blocks:[t]});
  assert.ok(text.includes('complete=false'));assert.ok(text.includes(`Unresolved column-header relationship (${reason}`));
  for(const label of labels)assert.ok(text.includes(label));assert.equal(JSON.stringify(t),before);
 }
 const simple=visualPageSearchText({complete:true,uncertain_spans:[],blocks:[table()]});
 assert.ok(simple.includes('Column header path (column 1; complete=true)'));assert.ok(!simple.includes('Unresolved column-header relationship'));
});

test('cache retains exact raw grid and rejects changed source/page/parser, raw, OCR or derived text',()=>{
 const value=page(),raw=JSON.stringify(value),body=encodeVisualBlockCache(binding,'b'.repeat(64),unavailable,raw);
 assert.deepEqual(readVisualBlockCache(body,binding).content,value);assert.equal(JSON.parse(body).rawOutput,raw);
 for(const changed of [{...binding,sourceHash:'c'.repeat(64)},{...binding,physicalPage:1},{...binding,parser:'pdf-visual-selected-v3:old'}])
  assert.throws(()=>readVisualBlockCache(body,changed),/cache identity/);
 for(const key of ['rawOutput','searchText','ocr']){
  const changed=JSON.parse(body);changed[key]=key==='ocr'?{status:'available',image:null,tsv:'edited'}:'edited';
  assert.throws(()=>readVisualBlockCache(JSON.stringify(changed),binding),/cache identity/);
 }
 assert.throws(()=>encodeVisualBlockCache(binding,'b'.repeat(64),unavailable,JSON.stringify({...value,complete:false})),/incomplete/);
});

const directory=mkdtempSync(join(tmpdir(),'pdf-block-tests-'));
process.env.DATABASE_URL=':memory:';process.env.LIBRARY_DIR=directory;process.env.SERVICE_VAULT_DIR=join(directory,'vault');
process.env.OPENAI_API_KEY='dummy-never-sent';process.env.AI_BUDGET_TEST_BYPASS='true';process.env.LOCAL_OCR='true';process.env.PDF_VISUAL_TILED_INPUT='false';
after(()=>rmSync(directory,{recursive:true,force:true}));
test('selected v4 makes one mocked request with original PNG/raw TSV, restores grid cache; unselected legacy stays flat',async()=>{
 const oldExec=childProcess.execFile,oldFetch=globalThis.fetch,png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP8zwACTGCSAQANHQEDgslx/wAAAABJRU5ErkJggg==','base64');
 const tsv='level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n5\t1\t1\t1\t1\t1\t0\t0\t2\t2\t90\tUncorrected\n';
 let renders=0,ocrs=0,calls=0;
 childProcess.execFile=((binary:string,args:string[],_opts:unknown,callback:(error:Error|null,stdout?:string,stderr?:string)=>void)=>{
  if(binary==='pdftoppm'){renders++;void writeFile(args[7]+'.png',png).then(()=>callback(null,'',''),e=>callback(e));}
  else {assert.equal(binary,'tesseract');assert.deepEqual(args.slice(1),['stdout','-l','eng+chi_sim','tsv']);ocrs++;callback(null,tsv,'');}
  return {};
 }) as unknown as typeof childProcess.execFile;
 Object.defineProperty(childProcess.execFile,promisify.custom,{value:(binary:string,args:string[],opts:unknown)=>new Promise((resolve,reject)=>
  (childProcess.execFile as any)(binary,args,opts,(error:Error|null,stdout:string,stderr:string)=>error?reject(error):resolve({stdout,stderr})))});
 syncBuiltinESMExports();
 try{
  const {transcribePdfVisualPages,selectedVisualPageCacheParser}=await import('../lib/document-parser.ts'),{database:db}=await import('../lib/database.ts');
  const pdf=await PDFDocument.create();pdf.addPage();const bytes=await pdf.save(),sourceHash=sha(bytes),options={pageNumbers:[1],expectedSourceHash:sourceHash,model:'gpt-5.4-mini',imageInput:true};
  await db.prepare('INSERT INTO library_parse_pages VALUES (?,?,0,?)').bind('typed','pdf-visual-selected-v3:old','old frozen cache').run();
  globalThis.fetch=async(_url,init)=>{
   calls++;const request=JSON.parse(String(init?.body));assert.equal(request.max_output_tokens,9000);assert.deepEqual(request.reasoning,{effort:'low'});
   if(request.text.format.name==='visual_page_blocks'){
    assert.deepEqual(request.text.format.schema,VISUAL_BLOCK_SCHEMA);
    const parts=request.input[0].content;assert.equal(parts.filter((x:any)=>x.type==='input_image').length,1);
    const observation=JSON.parse(parts.at(-1).text.split('\n').slice(1).join('\n'));
    assert.equal(observation.tsv,tsv);assert.equal(observation.image.sha256,sha(png));
    return Response.json({status:'completed',model:'gpt-5.4-mini',output_text:JSON.stringify(page())});
   }
   assert.equal(request.text.format.name,'visual_page_text');assert.equal(request.input[0].content.length,2);
   return Response.json({output_text:JSON.stringify({complete:true,uncertain_spans:[],text:'Legacy unselected text.'})});
  };
  const result=await transcribePdfVisualPages('typed',bytes,options),key=selectedVisualPageCacheParser(sourceHash,options.model,true);
  assert.ok(key.startsWith('pdf-visual-selected-v4:'));assert.equal(result[0].text,visualPageSearchText(page()));assert.equal(calls,1);assert.equal(ocrs,1);assert.equal(renders,1);
  const stored=await db.prepare('SELECT body FROM library_parse_pages WHERE document_id=? AND parser=?').bind('typed',key).first<{body:string}>();
  assert.deepEqual(readVisualBlockCache(stored!.body,{sourceHash,physicalPage:1,model:options.model,parser:key}).content,page());
  assert.deepEqual(await transcribePdfVisualPages('typed',bytes,options),result);assert.equal(calls,1);assert.equal(ocrs,1);assert.equal(renders,1);
  assert.equal((await db.prepare('SELECT body FROM library_parse_pages WHERE parser=?').bind('pdf-visual-selected-v3:old').first<{body:string}>())?.body,'old frozen cache');
  const legacy=await transcribePdfVisualPages('unselected',bytes,{imageInput:true,model:options.model});assert.equal(legacy[0].text,'Legacy unselected text.');assert.equal(ocrs,1);
  const corrupt=JSON.parse(stored!.body);corrupt.binding.physicalPage=2;
  await db.prepare('UPDATE library_parse_pages SET body=? WHERE document_id=? AND parser=?').bind(JSON.stringify(corrupt),'typed',key).run();
  await assert.rejects(transcribePdfVisualPages('typed',bytes,options),/cache identity/);assert.equal(calls,2,'invalid cache never triggers another request');
 }finally{globalThis.fetch=oldFetch;childProcess.execFile=oldExec;syncBuiltinESMExports();}
});
