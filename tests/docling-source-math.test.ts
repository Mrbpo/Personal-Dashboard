import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {join,relative,resolve} from 'node:path';
import {decodeDoclingResult} from '../lib/kernel/docling-result.ts';
import {prepareDoclingSourceMath,assertPreparedDoclingSourceMath,doclingMathBatchProvenance} from '../lib/kernel/docling-source-math.ts';

const base=resolve('data');mkdirSync(base,{recursive:true});const directory=mkdtempSync(join(base,'docling-source-math-'));
process.env.DATABASE_URL=':memory:';process.env.LIBRARY_DIR=directory;
process.env.KERNEL_DATABASE_URL='postgres://unused:unused@127.0.0.1:1/unused';
delete process.env.KERNEL_DOCUMENT_HYBRID;
after(()=>{assert.ok(relative(base,directory).startsWith('docling-source-math-'));rmSync(directory,{recursive:true,force:true});});
const ref=(v:string)=>({$ref:'#/'+v});
const item=(value:string,extra:Record<string,unknown>={})=>({text:value,prov:[{page_no:1}],...extra});
function fixture(){
 return {status:'success',document:{json_content:{pages:{1:{page_no:1,size:{width:600,height:800}}},
  body:{children:[ref('texts/0'),ref('texts/7')]},
  texts:[item('',{children:[ref('groups/0')]}),item('Let '),item('x_1',{label:'formula',orig:'x1',parent:ref('groups/0')}),
   item(' and H'),item('2',{formatting:{script:'sub',italic:false}}),item('O'),item(' .'),item('y^2',{label:'formula',orig:'y2'})],
  groups:[{self_ref:'#/groups/0',label:'inline',parent:ref('texts/0'),children:[1,2,3,4,5,6].map(i=>ref('texts/'+i))}],
  pictures:[],tables:[]}}};
}

test('actual inline groups preserve source spaces, formula mode and explicit scripts without reordering raw',()=>{
 const raw=fixture(),before=JSON.stringify(raw),decoded=decodeDoclingResult(raw,1,{formulaEnriched:true});
 assert.equal(decoded.pages[0].text,'Let \\(x_1\\) and H<sub>2</sub>O .\n\n$$\ny^2\n$$');
 const nodes=decoded.sourceMath![0].nodes;
 assert.equal(nodes.find(n=>n.reference==='#/texts/2')!.role,'inline-formula');
 assert.equal(nodes.find(n=>n.reference==='#/texts/7')!.role,'block-formula');
 const script=nodes.find(n=>n.reference==='#/texts/4')!;
 assert.deepEqual(script.path,['#/texts/0','#/groups/0','#/texts/4']);
 assert.deepEqual(script.raw.formatting,{script:'sub',italic:false});assert.deepEqual(script.raw.prov,[{page_no:1}]);
 assert.equal(JSON.stringify(raw),before);
 // An ordinary superscript is not proof of a math base. Keep its actual role.
 raw.document.json_content.texts[4]=item('<2>',{formatting:{script:'super'}});
 assert.match(decodeDoclingResult(raw,1).pages[0].text,/<sup>&lt;2&gt;<\/sup>/);
 const table:any=fixture();table.document.json_content.body.children=[ref('tables/0')];
 table.document.json_content.texts=table.document.json_content.texts.slice(0,7);
 table.document.json_content.tables=[{prov:[{page_no:1}],data:{num_rows:1,num_cols:1,table_cells:[{ref:ref('texts/0'),start_row_offset_idx:0,start_col_offset_idx:0}]}}];
 assert.equal(decodeDoclingResult(table,1).pages[0].text,'| Let \\(x_1\\) and H<sub>2</sub>O . |');
});

test('rejected enhancement stays orig; absent groups/unknown roles never repair flattened powers',()=>{
 const raw=fixture(),doc=raw.document.json_content;
 doc.texts[2]=item('f(x)=0',{label:'formula',orig:'f′(x)=0'});
 doc.texts[7]=item('n2',{formatting:{script:'unrecognized'}});
 const decoded=decodeDoclingResult(raw,1);
 assert.equal(decoded.pages[0].text,'Let f′(x)=0 and H<sub>2</sub>O .\n\nn2');
 assert.ok(decoded.warnings.some(w=>w.includes('changed')));assert.ok(!decoded.pages[0].text.includes('n^2'));
 doc.groups[0].label='unspecified';const missing=decodeDoclingResult(raw,1);
 assert.ok(!missing.pages[0].text.includes('<sub>'));assert.match(missing.warnings.join(' '),/未推断所属基符号/);
 const shared=fixture();shared.document.json_content.groups[0].children.push(ref('texts/2'));
 assert.throws(()=>decodeDoclingResult(shared),/cyclic or shared/);
 const wrong=fixture();wrong.document.json_content.groups[0].self_ref='#/groups/99';assert.throws(()=>decodeDoclingResult(wrong),/self reference/);
 const ambiguous=fixture();ambiguous.document.json_content.texts[0].text='Already complete paragraph';assert.throws(()=>decodeDoclingResult(ambiguous),/parent content is ambiguous/);
});

test('orig-only inline body and rich-cell leaves survive empty/blank text while actual spaces remain',()=>{
 const raw:any=fixture(),doc=raw.document.json_content;
 doc.texts=[item('',{label:'text',orig:'H'}),item('  ',{orig:'2',formatting:{script:'sub'}}),item(' '),item('',{orig:'O'})];
 doc.groups=[{label:'inline',children:[0,1,2,3].map(i=>ref('texts/'+i))}];doc.body.children=[ref('groups/0')];
 const frozen=JSON.stringify(raw),body=decodeDoclingResult(raw,1);
 assert.equal(body.pages[0].text,'H<sub>2</sub> O');assert.equal(JSON.stringify(raw),frozen);
 assert.equal(body.sourceMath![0].nodes.find(n=>n.reference==='#/texts/0')!.raw.orig,'H');
 assert.equal(body.sourceMath![0].nodes.find(n=>n.reference==='#/texts/1')!.raw.text,'  ');
 doc.body.children=[ref('tables/0')];doc.tables=[{prov:[{page_no:1}],data:{num_rows:1,num_cols:1,
  table_cells:[{ref:ref('groups/0'),start_row_offset_idx:0,start_col_offset_idx:0}]}}];
 const table=decodeDoclingResult(raw,1);assert.equal(table.pages[0].text,'| H<sub>2</sub> O |');
 assert.equal(table.nativeTables[0].cellTexts[0].text,'H<sub>2</sub> O');
});

test('controlled script search removes actual markers before fixed entity decoding without changing source',async()=>{
 const {documentSearchText}=await import('../lib/kernel/document-search.ts');
 const source='H<sub>2</sub>O and x<sup>2</sup>',before=source;
 assert.equal(documentSearchText(source),documentSearchText('H2O and x2'));assert.equal(source,before);
 assert.equal(documentSearchText('A<sub>&amp;&lt;&gt;</sub>B'),documentSearchText('A&<>B'));
 assert.equal(documentSearchText('H<sub>&lt;sup&gt;2&lt;/sup&gt;</sub>O'),'h sup 2 sup o');
 assert.equal(documentSearchText('A<sup>&amp;lt;</sup>B'),'a lt b','Decode fixed entities once, not recursively');
 assert.equal(documentSearchText('A &lt; B'),'a lt b','Plain original entities outside generated script tags remain literal');
 assert.match(documentSearchText('x<sup class="original">2</sup>'),/class/,'Do not add a general HTML parser');
});

async function cachedPipeline(){
 const {createDoclingProgress,convertDoclingBatches,storeDoclingResult}=await import('../lib/kernel/docling-batches.ts');
 const identity={owner:'math-owner',documentId:'math-doc',sourceHash:'a'.repeat(64),optionsHash:'b'.repeat(64),totalPages:2},progress=createDoclingProgress(identity);
 const prepare=async(start:number,end:number)=>({form:new FormData(),inputHash:String(start).repeat(64),copyIndices:[start-1]});
 for(const batch of progress.batches){
  const input=await prepare(batch.start,batch.end);Object.assign(batch,{inputHash:input.inputHash,copyIndices:input.copyIndices,
   resultHash:await storeDoclingResult({identity:{...identity,start:batch.start,end:batch.end,inputHash:input.inputHash,copyIndices:input.copyIndices},result:fixture()})});
 }
 const old=globalThis.fetch;globalThis.fetch=async()=>{throw Error('No HTTP permitted for saved-raw fixture');};
 try{
  const decoded=await convertDoclingBatches({identity,progress,verifiedBlankPages:[],formulaEnriched:true,endpoint:'http://not-used',headers:{},prepare,persist:async()=>{}});
  const sourceMath=await prepareDoclingSourceMath({owner:identity.owner,documentId:identity.documentId,sourceHash:identity.sourceHash,pages:decoded.pages,structures:decoded.sourceMath});
  assert.ok(sourceMath);return {identity,progress,decoded,sourceMath};
 }finally{globalThis.fetch=old;}
}

test('saved raw → real batch decoder → original page mapping → verified staging/GC; bad owner/raw/body rejected',async()=>{
 const {identity,progress,decoded,sourceMath}=await cachedPipeline();
 assert.deepEqual(decoded.sourceMath![1].nodes.find(n=>n.reference==='#/texts/2')!.derivedPageNumbers,[1]);
 assert.deepEqual(decoded.sourceMath![1].nodes.find(n=>n.reference==='#/texts/2')!.pageNumbers,[2]);
 assert.deepEqual(decoded.sourceMath![1].nodes.find(n=>n.reference==='#/texts/2')!.raw.prov,[{page_no:1}]);
 assertPreparedDoclingSourceMath(sourceMath,identity.owner,identity.documentId,identity.sourceHash,decoded.pages);
 assert.throws(()=>assertPreparedDoclingSourceMath({...sourceMath},identity.owner,identity.documentId,identity.sourceHash,decoded.pages),/staging/);
 assert.throws(()=>assertPreparedDoclingSourceMath(sourceMath,identity.owner,identity.documentId,identity.sourceHash,[{pageNumber:1,text:'changed'}]),/page body/);
 await assert.rejects(prepareDoclingSourceMath({owner:'other',documentId:identity.documentId,sourceHash:identity.sourceHash,pages:decoded.pages,structures:decoded.sourceMath}),/owner\/source/);
 const modified=structuredClone(decoded.sourceMath!);modified[0].nodes[0].raw.text='invented';
 await assert.rejects(prepareDoclingSourceMath({owner:identity.owner,documentId:identity.documentId,sourceHash:identity.sourceHash,pages:decoded.pages,structures:modified}),/actual saved raw/);
 const {parsingProvenanceBlobHashes}=await import('../lib/kernel/docling-batches.ts');
 const hashes=await parsingProvenanceBlobHashes(doclingMathBatchProvenance(sourceMath,progress),identity);
 for(const batch of progress.batches)assert.ok(hashes.includes(batch.resultHash!));
});

test('real Kernel ingestion stores source math in existing structure/evidence; current reader exposes it (mock SQL, no PG)',async t=>{
 const {identity,progress,decoded,sourceMath}=await cachedPipeline(),{kernel}=await import('../lib/kernel/service.ts'),{kernelPool}=await import('../lib/kernel/db.ts');
 const state:{version?:string;sourceVersion?:string;parser?:string;raw?:any;manifest?:any;manifestHash?:string;pages:any[];evidence:any[];statements:string[]}={pages:[],evidence:[],statements:[]};
 const query=async(sql:string,args:any[]=[])=>{
  state.statements.push(sql);
  if(sql.includes('INSERT INTO source_item_versions')){state.sourceVersion=args[0];state.raw=JSON.parse(args[3]);}
  else if(sql.includes('INSERT INTO document_text_versions')){state.version=args[0];state.parser=args[3];}
  else if(sql.includes('INSERT INTO evidence('))state.evidence.push(JSON.parse(args[6]));
  else if(sql.includes('INSERT INTO document_text_pages'))state.pages.push({page_number:args[1],evidence_id:args[2],locator:args[3],body:args[4],search_text:args[5],search_hint_provenance:null});
  else if(sql==="SELECT raw_value->'batchProvenance' progress FROM source_item_versions WHERE id=$1 FOR UPDATE"){
   assert.deepEqual(args,[state.sourceVersion]);return {rows:[{progress:state.raw.batchProvenance}]};
  }
  else if(sql==='SELECT body,search_text,search_hint_provenance FROM document_text_pages WHERE version_id=$1 AND page_number=$2 FOR UPDATE'){
   assert.equal(args[0],state.version);const page=state.pages.find(p=>p.page_number===args[1]);assert.ok(page);return {rows:[page]};
  }
  else if(sql==='UPDATE document_text_pages SET search_text=$3,search_hint_provenance=$4::jsonb WHERE version_id=$1 AND page_number=$2'){
   assert.equal(args[0],state.version);const page=state.pages.find(p=>p.page_number===args[1]);assert.ok(page);
   page.search_text=args[2];page.search_hint_provenance=args[3]===null?null:JSON.parse(args[3]);
  }
  else if(sql.includes('SELECT owner_id,source_hash FROM document_texts'))return {rows:[{owner_id:identity.owner,source_hash:identity.sourceHash}]};
  else if(sql.includes('SELECT d.id "documentId"'))return {rows:[{documentId:identity.documentId,currentVersionId:state.version,sourceVersionId:state.sourceVersion,sourceHash:identity.sourceHash,
   courseId:'',rawSourceHash:identity.sourceHash,name:'Fixture.pdf',origin:'test',originKey:'fixture',parserVersion:state.parser,mime:'application/pdf',extractionMethod:'docling-text'}]};
  else if(sql.includes('SELECT p.page_number,p.evidence_id'))return {rows:state.pages};
  else if(sql.startsWith('SELECT page_count'))return {rows:[{page_count:2}]};
  else if(sql.includes('INSERT INTO document_structures')){state.manifest=JSON.parse(args[6]);state.manifestHash=args[5];}
  else if(sql.includes('SELECT manifest_sha256 FROM document_structures'))return {rows:[{manifest_sha256:state.manifestHash}]};
  else if(sql.includes('SELECT manifest,manifest_sha256,raw_source_hash'))return {rows:[{manifest:state.manifest,manifest_sha256:state.manifestHash,raw_source_hash:identity.sourceHash}]};
  else if(!/^(BEGIN|COMMIT|ROLLBACK|SELECT pg_advisory|INSERT INTO source_items|INSERT INTO document_texts|INSERT INTO document_text_chunks|UPDATE document_texts)/.test(sql.trim()))throw Error('Unexpected SQL in fake-only ingestion: '+sql);
  return {rows:[]};
 };
 const pool=kernelPool();t.mock.method(pool,'connect',async()=>({query,release:()=>{}}) as any);t.mock.method(pool,'query',query as any);
 await kernel.ingestParsedDocument({id:identity.documentId,ownerId:identity.owner,courseId:'',name:'Fixture.pdf',hash:identity.sourceHash,mime:'application/pdf',origin:'test',originKey:'fixture'},
  decoded.pages,{parserVersion:'docling-source-math-fixture',warnings:decoded.warnings,batchProvenance:progress,sourceMath});
 assert.equal(state.raw.sourceMathSha256,sourceMath.sha256);assert.deepEqual(state.manifest.sourceMath,sourceMath.provenance);
 assert.ok(state.pages.every(p=>typeof p.search_text==='string'&&p.search_hint_provenance?.binding.sourceVersionId===state.sourceVersion));
 assert.ok(state.evidence.every(e=>e.sourceMath.provenanceSha256===sourceMath.sha256&&e.sourceMath.formulaRelationsVerified===false));
 const source={documentId:identity.documentId,currentVersionId:state.version!,sourceVersionId:state.sourceVersion!,sourceHash:identity.sourceHash,courseId:''};
 const outline=await kernel.readDocumentOutline(identity.owner,source);
 assert.equal(outline.nodes[1].sourceMath!.sourceProven,false);
 assert.deepEqual(outline.nodes[1].sourceMath!.structures[0].nodes.find(n=>n.reference==='#/texts/2')!.pageNumbers,[2]);
 const oldBody=state.pages[0].body;state.pages[0].body+=' tampered';
 await assert.rejects(kernel.readDocumentOutline(identity.owner,source),/binding differs|no longer current/);state.pages[0].body=oldBody;
 const writes=state.statements.length;
 await assert.rejects(kernel.ingestParsedDocument({id:identity.documentId,ownerId:'other',courseId:'',name:'Fixture.pdf',hash:identity.sourceHash,mime:'application/pdf',origin:'test',originKey:'fixture'},decoded.pages,{sourceMath}),/staging/);
 assert.equal(state.statements.length,writes);
});
