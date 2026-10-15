import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeDoclingResult } from '../lib/kernel/docling-result.ts';

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
