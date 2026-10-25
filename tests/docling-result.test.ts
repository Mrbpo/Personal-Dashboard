import { test } from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import { decodeDoclingResult, DOCLING_NUL_PROJECTION_VERSION, DOCLING_EMPTY_TABLE_OBSERVATION_VERSION } from '../lib/kernel/docling-result.ts';
import {prepareNativeTableArtifact,nativeTableSearchStrings} from '../lib/kernel/document-table-candidates.ts';

const ref = (name: string) => ({$ref: `#/${name}`});
const item = (content: string, page = 1, extra: Record<string, unknown> = {}) => ({text: content, prov: [{page_no: page}], ...extra});
function result(pages = 1) {
  return {status: 'success', document: {json_content: {
    pages: Object.fromEntries(Array.from({length: pages}, (_, index) => [index + 1, {page_no: index + 1, size: {width: 600, height: 800}}])),
    body: {children: [ref('texts/0')]}, furniture: {children: [] as unknown[]},
    texts: [item('Readable introduction')] as Record<string, unknown>[],
    groups: [] as Record<string, unknown>[], tables: [] as Record<string, unknown>[], pictures: [] as Record<string, unknown>[],
  }}};
}

function tableResult(data:Record<string,unknown>){
 const value=result(),doc=value.document.json_content;
 doc.body.children=[ref('tables/0')];
 doc.texts=[];
 doc.tables=[{prov:[{page_no:1}],data}];
 return value;
}

test('explicit empty table detections retain raw unknown structure and surrounding text',()=>{
 const value=result(),doc=value.document.json_content;
 const empty={num_rows:0,num_cols:0,table_cells:[],grid:[]};
 doc.body.children.push(ref('tables/0'));
 doc.tables=[{self_ref:'#/tables/0',prov:[{page_no:1,bbox:{l:1,t:20,r:100,b:10,coord_origin:'BOTTOMLEFT'}}],data:empty}];
 const before=JSON.stringify(value),decoded=decodeDoclingResult(value,1,{formulaEnriched:false});
 assert.equal(JSON.stringify(value),before);
 assert.equal(decoded.pages[0].text,'Readable introduction');
 assert.equal(decoded.nativeTables.length,1);
 assert.deepEqual(decoded.nativeTables[0].raw,doc.tables[0]);
 assert.deepEqual(decoded.nativeTables[0].cellTexts,[]);
 assert.deepEqual(decoded.nativeTables[0].pageNumbers,[1]);
 assert(decoded.warnings.some(w=>w.includes(DOCLING_EMPTY_TABLE_OBSERVATION_VERSION)));
 const artifact=prepareNativeTableArtifact(decoded.nativeTables[0]);
 assert.equal(artifact.status,'unavailable');assert(artifact.reasons.includes('unsupported-grid'));
 assert.equal(nativeTableSearchStrings(artifact),'');
});

test('empty detection exception neither repairs invalid grids nor certifies an unreadable page as blank',()=>{
 for(const data of [
  {num_rows:0,num_cols:1,table_cells:[]},{num_rows:1,num_cols:0,table_cells:[]},
  {num_rows:0,num_cols:0,table_cells:[{text:'conflict',start_row_offset_idx:0,start_col_offset_idx:0}]},
  {num_rows:0,num_cols:0,table_cells:[],grid:[['conflict']]},
  {num_rows:0,num_cols:0},
 ])assert.throws(()=>decodeDoclingResult(tableResult(data),1),/invalid or oversized declared grid/);
 const onlyEmpty=tableResult({num_rows:0,num_cols:0,table_cells:[],grid:[]});
 assert.throws(()=>decodeDoclingResult(onlyEmpty,1,{verifiedBlankPages:[1]}),/has content but no readable transcription/);
});

test('table projection rejects out-of-grid starts and duplicate starts even when text is empty',()=>{
 const cell=(text:string,row=0,col=0)=>({text,start_row_offset_idx:row,start_col_offset_idx:col});
 const cases=[
  {num_rows:1,num_cols:2,table_cells:[cell('A'),cell('outside',0,3)]},
  {num_rows:1,num_cols:1,table_cells:[cell('A'),cell('outside',2)]},
  {num_rows:1,num_cols:1,table_cells:[cell('original'),cell('')]},
  {num_rows:1,num_cols:1,table_cells:[cell(''),cell('replacement')]},
 ];
 for(const data of cases){
  const value=tableResult(data),before=JSON.stringify(value);
  assert.throws(()=>decodeDoclingResult(value,1),/invalid cell coordinates|overlapping cell coordinates/);
  assert.equal(JSON.stringify(value),before,'Conflicting native input is retained, never repaired or overwritten');
 }
});

test('valid table projection preserves sparse positions, explicit spans and unknown optional dimensions',()=>{
 const table_cells=[
  {text:'merged | heading',start_row_offset_idx:0,start_col_offset_idx:0,row_span:1,col_span:2,end_row_offset_idx:1,end_col_offset_idx:2},
  {text:'line one\nline two',start_row_offset_idx:1,start_col_offset_idx:1},
 ];
 for(const dimensions of [{num_rows:2,num_cols:2},{}]){
  const value=tableResult({...dimensions,table_cells}),before=JSON.stringify(value);
  const decoded=decodeDoclingResult(value,1);
  assert.equal(decoded.pages[0].text,'| merged \\| heading |  |\n|  | line one line two |');
  assert.deepEqual(decoded.nativeTables[0].cellTexts,[{cellIndex:0,text:'merged | heading'},{cellIndex:1,text:'line one\nline two'}]);
  assert.equal(JSON.stringify(value),before);
  assert.deepEqual(decoded.nativeTables[0].raw.data,{...dimensions,table_cells});
 }
});

test('oversized table coordinates, declared dimensions and cell counts fail before grid allocation',()=>{
 // Isolate this regression: even a broken guard cannot exhaust the test runner.
 const moduleUrl=new URL('../lib/kernel/docling-result.ts',import.meta.url).href;
 const child=spawnSync(process.execPath,['--max-old-space-size=96','--experimental-strip-types','--input-type=module','-e',`
  import assert from 'node:assert/strict';
  import {decodeDoclingResult} from ${JSON.stringify(moduleUrl)};
  const cell={text:'A',start_row_offset_idx:0,start_col_offset_idx:0};
  const cases=[
   {table_cells:[{...cell,start_col_offset_idx:1000000000}]},
   {table_cells:[{...cell,start_row_offset_idx:1000000000}]},
   {num_rows:1,num_cols:1000000000,table_cells:[cell]},
   {num_rows:1000000000,num_cols:1,table_cells:[cell]},
   {table_cells:Array.from({length:10001},()=>({...cell}))},
   {num_rows:0,num_cols:1,table_cells:[cell]},
  ];
  for(const data of cases){
   const value={status:'success',document:{json_content:{pages:{1:{page_no:1}},body:{children:[{$ref:'#/tables/0'}]},tables:[{prov:[{page_no:1}],data}]}}};
   assert.throws(()=>decodeDoclingResult(value,1),/invalid cell coordinates|invalid or oversized declared grid|exceeds cell limit/);
  }
  console.log('six bounded failures');
 `],{encoding:'utf8',timeout:3000,maxBuffer:8192});
 assert.equal(child.error,undefined);
 assert.equal(child.status,0,child.stderr);
 assert.equal(child.stdout.trim(),'six bounded failures');
});

test('native bibliography marker remains bound to its own source text without changing raw provenance',()=>{
 // Public KALM saved result 6b23b249... /texts/5; local page 1 maps to original page 7.
 const value=result(),doc=value.document.json_content;
 const bibliography='Yuyu Zhang, Hanjun Dai, Zornitsa Kozareva, Alexander J. Smola & Le Song (2018): Variational Reasoning forQuestionAnsweringWithKnowledgeGraph. InSheilaA.McIlraith&KilianQ.Weinberger,editors: Proceedings of the 32nd AAAI Conference on Artificial Intelligence (AAAI-18), AAAI Press, New Orleanz, LA, pp. 6069-6076.';
 doc.texts=[item(bibliography,1,{label:'list_item',marker:'[20]',enumerated:true,
  prov:[{page_no:1,charspan:[0,bibliography.length],bbox:{l:79.228,t:588.312,r:532.776,b:543.725,coord_origin:'BOTTOMLEFT'}}]})];
 const before=JSON.stringify(value);
 const decoded=decodeDoclingResult(value,1,{formulaEnriched:false});
 assert.equal(decoded.pages[0].text,`[20] ${bibliography}`);
 assert.equal(decoded.pages[0].pageNumber,1,'Physical mapping remains the derived-page adapter responsibility');
 assert.equal(JSON.stringify(value),before,'Native marker, text, ranges and bbox remain immutable');
});

test('list projection neither invents numbering nor duplicates embedded markers',()=>{
 const value=result(),doc=value.document.json_content;
 doc.texts=[item('[7] Existing reference',1,{label:'list_item',marker:'[7]',enumerated:true}),
  item('[8]Attached reference',1,{label:'list_item',marker:'[8]'}),
  item('Unnumbered reference',1,{label:'list_item',enumerated:true}),
  item('Ordinary text',1,{label:'text',marker:'[99]'}),
  item('Bullet text',1,{label:'list_item',marker:'•',enumerated:false}),
  item('10 samples',1,{label:'list_item',marker:'1'}),
  item('Fallback text',1,{label:'list_item',marker:'[9]',text:'',orig:'Fallback text'})];
 doc.body.children=doc.texts.map((_,index)=>ref(`texts/${index}`));
 assert.equal(decodeDoclingResult(value).pages[0].text,
  '[7] Existing reference\n\n[8]Attached reference\n\nUnnumbered reference\n\nOrdinary text\n\n• Bullet text\n\n1 10 samples\n\n[9] Fallback text');
});

test('list markers do not shift native spanning character ranges or repeat on continuation pages',()=>{
 for(const [body,cut,expected]of [
  ['firstsecond',5,['[20] first','second']],
  ['[20] firstsecond',2,['[2','0] firstsecond']],
 ] as const){
  const value=result(2);
  value.document.json_content.texts=[{label:'list_item',marker:'[20]',text:body,
   prov:[{page_no:1,charspan:[0,cut]},{page_no:2,charspan:[cut,body.length]}]}];
  const before=JSON.stringify(value);
  assert.deepEqual(decodeDoclingResult(value,2).pages.map(page=>page.text),expected);
  assert.equal(JSON.stringify(value),before);
 }
});

test('native list markers are consistent in table references and picture child text',()=>{
 const value=result(),doc=value.document.json_content;
 doc.texts=[item('Table entry',1,{label:'list_item',marker:'[4]'}),
  item('Picture entry',1,{label:'list_item',marker:'[5]',parent:ref('pictures/0')})];
 doc.tables=[{prov:[{page_no:1}],data:{num_rows:1,num_cols:1,table_cells:[{ref:ref('texts/0'),start_row_offset_idx:0,start_col_offset_idx:0}]}}];
 doc.pictures=[{prov:[{page_no:1,bbox:{l:10,t:10,r:100,b:100,coord_origin:'TOPLEFT'}}],children:[ref('texts/1')]}];
 doc.body.children=[ref('tables/0'),ref('pictures/0')];
 const before=JSON.stringify(value),decoded=decodeDoclingResult(value);
 assert.equal(decoded.pages[0].text,'| [4] Table entry |\n\n[5] Picture entry');
 assert.equal(decoded.nativeTables[0].cellTexts[0].text,'[4] Table entry');
 assert.equal(decoded.visualLayout.regions[0].textReferences[0].text,'[5] Picture entry');
 assert.equal(JSON.stringify(value),before);
});

test('NUL projection marks unknown body and picture characters without altering raw or unaffected pages',()=>{
 const value=result(2),doc=value.document.json_content;
 doc.texts=[item('before\0after',1,{orig:'before\0after'}),
  item('axis\0label',1,{parent:ref('pictures/0'),orig:'axis\0label'}),item('Unchanged α + β.',2)];
 doc.pictures=[{prov:[{page_no:1,bbox:{l:10,t:10,r:100,b:100,coord_origin:'TOPLEFT'}}],children:[ref('texts/1')]}];
 doc.body.children=[ref('texts/0'),ref('pictures/0'),ref('texts/2')];
 const raw=JSON.stringify(value),decoded=decodeDoclingResult(value,2,{formulaEnriched:false});
 assert.equal(JSON.stringify(value),raw);
 assert.equal(decoded.pages[0].text,'before�after\n\naxis�label');
 assert.equal(decoded.pages[0].text.length,'before\0after\n\naxis\0label'.length);
 assert.equal(decoded.pages[1].text,'Unchanged α + β.');
 assert.equal(decoded.visualLayout.regions[0].textReferences[0].text,'axis�label');
 assert.equal(decoded.visualLayout.regions[0].pictureRef,'#/pictures/0');
 assert.equal(decoded.visualLayout.regions[0].pageNumber,1);
 assert.equal(decoded.warnings.filter(w=>w.includes(DOCLING_NUL_PROJECTION_VERSION)).length,1);
 assert.match(decoded.warnings.find(w=>w.includes(DOCLING_NUL_PROJECTION_VERSION))!,/第 1 页.*2 个 NUL/);
});

test('Docling source preservation keeps original formula strings in body, table and picture references even in text mode',()=>{
 const value=result(),doc=value.document.json_content;
 doc.texts=[item('f(x)=0',1,{label:'formula',orig:'f′(x)=0'}),
  item('\\min\\{a\\}\\cup\\{b\\}',1,{label:'formula',orig:'min{{a}∪{b}}'}),
  item('\\sqrt{x}',1,{label:'formula',orig:'√x'}),
  item('\\alpha_1+\\beta_2=3',1,{label:'formula',orig:'α1+β2=3'}),
  item('g(x)=0',1,{label:'formula',orig:'g′(x)=0',parent:ref('pictures/0')})];
 doc.tables=[{prov:[{page_no:1}],data:{num_rows:1,num_cols:1,table_cells:[{ref:ref('texts/1'),start_row_offset_idx:0,start_col_offset_idx:0}]}}];
 doc.pictures=[{prov:[{page_no:1,bbox:{l:10,t:10,r:100,b:100,coord_origin:'TOPLEFT'}}],children:[ref('texts/4')]}];
 doc.body.children=[ref('texts/0'),ref('tables/0'),ref('texts/2'),ref('texts/3'),ref('pictures/0')];
 const original=JSON.stringify(value);
 for(const formulaEnriched of [true,false]){
  const decoded=decodeDoclingResult(value,1,{formulaEnriched});
  assert.equal(decoded.pages[0].text,'f′(x)=0\n\n| min{{a}∪{b}} |\n\n√x\n\n'+
   (formulaEnriched?'$$\n\\alpha_1+\\beta_2=3\n$$':'\\alpha_1+\\beta_2=3')+'\n\ng′(x)=0');
  assert.equal(decoded.nativeTables[0].cellTexts[0].text,'min{{a}∪{b}}');
  assert.equal(decoded.visualLayout.regions[0].textReferences[0].text,'g′(x)=0');
  assert.ok(decoded.warnings.some(w=>w.includes('changed')));
  assert.ok(decoded.warnings.some(w=>w.includes('unassessed')));
  assert.ok(decoded.warnings.some(w=>w.includes('保留原始抽取文本')));
 }
 assert.equal(JSON.stringify(value),original,'Raw extraction and rejected machine text remain immutable');
});

test('reading order follows nested body refs, not text array order, with formula and table content', () => {
  const value = result(2), doc = value.document.json_content;
  doc.texts = [item('Conclusion', 2), item('Introduction'), item('x^2 + y^2 = z^2', 1, {label: 'formula'}), item('Study schedule', 2)];
  doc.groups = [{children: [ref('texts/1'), ref('texts/2'), ref('tables/0')]}];
  doc.body.children = [ref('groups/0'), ref('texts/0')];
  doc.tables = [{prov: [{page_no: 2}], captions: [ref('texts/3')], data: {num_rows: 2, num_cols: 2, table_cells: [
    {text: 'Week 7', start_row_offset_idx: 1, start_col_offset_idx: 0},
    {text: 'Bayes theorem', start_row_offset_idx: 1, start_col_offset_idx: 1},
    {text: 'Topic', start_row_offset_idx: 0, start_col_offset_idx: 1},
    {text: 'Week', start_row_offset_idx: 0, start_col_offset_idx: 0},
  ]}}];
  const decoded = decodeDoclingResult(value, 2, {formulaEnriched:true});
  assert.equal(decoded.pages[0].text, 'Introduction\n\n$$\nx^2 + y^2 = z^2\n$$');
  assert.equal(decoded.pages[1].text, '| Week | Topic |\n| Week 7 | Bayes theorem |\n\nStudy schedule\n\nConclusion');
  assert.deepEqual(decoded.pages.map(page => [page.pageNumber, page.locator]), [[1, '第 1 页'], [2, '第 2 页']]);
  assert.ok(decoded.warnings.includes('第 1 页机器公式未核验符号和上下标，请核对原 PDF'));
});

test('successful manifest preserves a blank page without shifting later citations', () => {
  const value = result(3), doc = value.document.json_content;
  doc.texts.push(item('Last page', 3));
  doc.body.children.push(ref('texts/1'));
  assert.throws(() => decodeDoclingResult(value, 3), /page 2 is blank_or_unreadable/);
  const decoded = decodeDoclingResult(value, 3, {verifiedBlankPages: [2]});
  assert.equal(decoded.pages[1].text, '');
  assert.equal(decoded.pages[2].pageNumber, 3);
  assert.equal(decoded.warnings.length, 1);
});

test('multi-page text uses complete provenance character spans', () => {
  const value = result(2);
  value.document.json_content.texts = [{text: 'firstsecond', prov: [{page_no: 1, charspan: [0, 5]}, {page_no: 2, charspan: [5, 11]}]}];
  assert.deepEqual(decodeDoclingResult(value, 2).pages.map(page => page.text), ['first', 'second']);
});

test('reject failed, partial, markdown-only and page-loss conversions', () => {
  assert.throws(() => decodeDoclingResult({...result(), status: 'partial_success'}), /incomplete/);
  assert.throws(() => decodeDoclingResult({...result(), status: 'failure'}), /incomplete/);
  assert.throws(() => decodeDoclingResult({...result(), errors: ['OCR failed']}), /errors/);
  assert.throws(() => decodeDoclingResult({status: 'success', document: {md_content: 'Unlocated content'}}), /structured/);
  assert.throws(() => decodeDoclingResult(result(), 2), /manifest/);
  const gap = result(3);
  delete (gap.document.json_content.pages as Record<string, unknown>)['2'];
  assert.throws(() => decodeDoclingResult(gap), /manifest/);
});

test('reject missing, invalid and ambiguous provenance rather than quietly omit text', () => {
  for (const prov of [[], [{page_no: 0}], [{page_no: '1'}], [{page_no: 4}]]) {
    const value = result();
    value.document.json_content.texts[0].prov = prov;
    assert.throws(() => decodeDoclingResult(value), /provenance/);
  }
  const spanning = result(2);
  spanning.document.json_content.texts[0].prov = [{page_no: 1}, {page_no: 2}];
  assert.throws(() => decodeDoclingResult(spanning), /ambiguous/);
});

test('image-only and empty formula pages are not searchable successful transcriptions', () => {
  const image = result(2), doc = image.document.json_content;
  doc.pictures = [{prov: [{page_no: 2}], children: []}];
  doc.body.children.push(ref('pictures/0'));
  assert.throws(() => decodeDoclingResult(image), /no readable transcription/);
  const formula = result();
  formula.document.json_content.texts[0] = item('', 1, {label: 'formula'});
  assert.throws(() => decodeDoclingResult(formula), /LaTeX/);
  const blank = result();
  blank.document.json_content.texts = [];
  blank.document.json_content.body.children = [];
  assert.throws(() => decodeDoclingResult(blank, 1, {verifiedBlankPages: [1]}), /no readable text/);
});

test('captions are kept once and unreferenced text, broken refs and cycles fail safely', () => {
  const image = result(), doc = image.document.json_content;
  doc.texts.push(item('Figure 1: Regression model'));
  doc.pictures = [{prov: [{page_no: 1}], captions: [ref('texts/1')]}];
  doc.body.children.push(ref('pictures/0'), ref('texts/1'));
  const decoded=decodeDoclingResult(image);
  assert.equal(decoded.pages[0].text, 'Readable introduction\n\nFigure 1: Regression model');
  assert.equal(decoded.visualLayout.status,'unavailable');
  assert.match(decoded.visualLayout.reason||'',/geometry unavailable/);
  assert.deepEqual(decoded.visualLayout.unavailablePictures?.[0].provenance,[{page_no:1}]);
  const orphan = result();
  orphan.document.json_content.texts.push(item('Lost content'));
  assert.throws(() => decodeDoclingResult(orphan), /unreferenced/);
  const broken = result();
  broken.document.json_content.body.children = [ref('texts/9')];
  assert.throws(() => decodeDoclingResult(broken), /does not exist/);
  const cycle = result();
  cycle.document.json_content.groups = [{children: [ref('groups/0')]}];
  cycle.document.json_content.body.children = [ref('groups/0')];
  assert.throws(() => decodeDoclingResult(cycle), /cycle/);
});

test('text-only mode keeps readable formula text without claiming LaTeX enrichment',()=>{
  const value=result();
  value.document.json_content.texts[0]=item('E = m c 2',1,{label:'formula'});
  const decoded=decodeDoclingResult(value,1,{formulaEnriched:false});
  assert.equal(decoded.pages[0].text,'E = m c 2');
  assert.match(decoded.warnings[0],/公式增强未启用/);
  value.document.json_content.texts.push(item('',1,{label:'formula'}));
  value.document.json_content.body.children.push(ref('texts/1'));
  const incomplete=decodeDoclingResult(value,1,{formulaEnriched:false});
  assert.match(incomplete.warnings.join(' '),/尚未转写/);
  assert.deepEqual(incomplete.formulaPageNumbers,[1]);
});

test('empty normalized text keeps original math verbatim without claiming enriched LaTeX',()=>{
  const value=result(),doc=value.document.json_content;
  doc.texts=[item(' ',1,{label:'formula',orig:'  min max θ + α\nΓ(a)Γ(a)  '}),item('Normalized content',1,{orig:'Original content'})];
  doc.body.children.push(ref('texts/1'));
  for(const formulaEnriched of [false,true]){
    const decoded=decodeDoclingResult(value,1,{formulaEnriched});
    assert.equal(decoded.pages[0].text,'min max θ + α\nΓ(a)Γ(a)  \n\nNormalized content');
    assert.ok(!decoded.pages[0].text.includes('$$'));
    assert.match(decoded.warnings.join(' '),/原始抽取文本.*未验证 LaTeX/);
    assert.deepEqual(decoded.formulaPageNumbers,[1]);
  }
});

test('original-only spanning content respects provenance and orphan content cannot disappear',()=>{
  const spanning=result(2);
  spanning.document.json_content.texts=[{text:'',orig:'firstsecond',prov:[{page_no:1,charspan:[0,5]},{page_no:2,charspan:[5,11]}]}];
  assert.deepEqual(decodeDoclingResult(spanning,2).pages.map(page=>page.text),['first','second']);
  const orphan=result();
  orphan.document.json_content.texts.push(item('',1,{orig:'Unreferenced original formula'}));
  assert.throws(()=>decodeDoclingResult(orphan),/unreferenced/);
});
