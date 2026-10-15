import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {PDFDocument} from 'pdf-lib';
import {pdfFormulaCacheIdentity,pdfFormulaCacheParser,appendPdfLatex} from '../lib/pdf-formulas.ts';

const directory=mkdtempSync(join(tmpdir(),'study-tests-formula-cache-'));
process.env.DATABASE_URL=':memory:';
process.env.LIBRARY_DIR=join(directory,'library');
process.env.SERVICE_VAULT_DIR=join(directory,'private');
process.env.AI_BUDGET_TEST_BYPASS='true';
process.env.OPENAI_MODEL='gpt-5-mini';
process.env.LOCAL_OCR='false';
delete process.env.DOCLING_URL;
after(()=>rmSync(directory,{recursive:true,force:true}));
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');

test('complete formula cache binds source, physical page, base, model and policy; matching reads make no request',async()=>{
 const {database:db}=await import('../lib/database.ts');
 const {enrichParsedPdfFormulae}=await import('../lib/document-parser.ts');
 const pdf=await PDFDocument.create();pdf.addPage();pdf.addPage();const bytes=await pdf.save(),sourceHash=hash(bytes),
  id='formula-cache-identity',page={pageNumber:1,locator:'第 1 页',text:'Original equation E=mc2 and original caution.'};
 const before=globalThis.fetch;let calls=0;
 globalThis.fetch=async()=>{calls++;return Response.json({output_text:JSON.stringify({formulae:['E=mc^{2}'],complete:true})});};
 try{
  const first=await enrichParsedPdfFormulae(id,bytes,[page]);assert.equal(calls,1);assert.equal(first.warnings.length,0);
  assert.ok(first.pages[0].text.startsWith(page.text));assert.match(first.pages[0].text,/请核对原页/u);
  assert.deepEqual(await enrichParsedPdfFormulae(id,bytes,[page]),first);assert.equal(calls,1);
  const parser=pdfFormulaCacheParser(pdfFormulaCacheIdentity(sourceHash,1,page.text,'gpt-5-mini')),
   saved=await db.prepare('SELECT body FROM library_parse_pages WHERE document_id=? AND parser=? AND page=0').bind(id,parser).first<{body:string}>();
  assert.ok(saved);assert.equal(JSON.parse(saved.body).verification,'machine-unverified');
  process.env.OPENAI_MODEL='another-configured-model';await enrichParsedPdfFormulae(id,bytes,[page]);assert.equal(calls,2);
  process.env.OPENAI_MODEL='gpt-5-mini';
  pdf.setTitle('different original source');await enrichParsedPdfFormulae(id,await pdf.save(),[page]);assert.equal(calls,3);
  await enrichParsedPdfFormulae(id,bytes,[{...page,pageNumber:2,locator:'第 2 页'}]);assert.equal(calls,4);
  await enrichParsedPdfFormulae(id,bytes,[{...page,text:page.text+' Changed base.'}]);assert.equal(calls,5);
  // A legacy key stays intact. A forged matching key with the wrong policy is
  // retained but refused, without a surprise request or complete-cache claim.
  await db.prepare('INSERT INTO library_parse_pages VALUES (?,?,0,?)').bind(id,'docling-ai-formula-v1:legacy',first.pages[0].text).run();
  const unknown=JSON.parse(saved.body);unknown.identity.policySha256='0'.repeat(64);
  await db.prepare('UPDATE library_parse_pages SET body=? WHERE document_id=? AND parser=? AND page=0').bind(JSON.stringify(unknown),id,parser).run();
  const refused=await enrichParsedPdfFormulae(id,bytes,[page]);assert.equal(calls,5);assert.equal(refused.warnings.length,1);
  assert.match(refused.pages[0].text,/本页公式识别不完整/u);
  assert.equal((await db.prepare('SELECT body FROM library_parse_pages WHERE document_id=? AND parser=? AND page=0').bind(id,'docling-ai-formula-v1:legacy').first<{body:string}>())?.body,first.pages[0].text);
 }finally{globalThis.fetch=before;process.env.OPENAI_MODEL='gpt-5-mini';}
});

test('malformed output stays partial; only explicit force recovers a v3-only page once and preserves prior text/warnings',async()=>{
 const {database:db}=await import('../lib/database.ts');
 const {saveDocument}=await import('../lib/library.ts');
 const {enrichParsedPdfFormulae,parsePdfPages,PDF_PARSER_VERSION,pdfFormulaPageNeedsRecovery}=await import('../lib/document-parser.ts');
 const {getPdfFormulaReparseStatus,queuePdfFormulaReparse}=await import('../lib/pdf-formula-reparse.ts');
 const pdf=await PDFDocument.create();pdf.addPage();const bytes=await pdf.save(),sourceHash=hash(bytes),owner='formula-cache-recovery',
  id=await saveDocument(owner,'','upload','partial','partial.pdf','application/pdf',bytes),
  base='Original source paragraph E=mc2. [原告警：请核对原文]';
 const before=globalThis.fetch;let calls=0,valid=false;
 globalThis.fetch=async()=>{calls++;return Response.json({output_text:JSON.stringify({
  formulae:valid?['E=mc^{2}']:['E=mc^{2}','\\begin{bmatrix}1&0','\\frac{a}{b','\u0000'],complete:true})});};
 try{
  const partial=(await enrichParsedPdfFormulae(id,bytes,[{pageNumber:1,locator:'第 1 页',text:base}])).pages[0].text;
  assert.equal(calls,1);assert.ok(partial.startsWith(base));assert.match(partial,/部分公式无法可靠识别/u);
  assert.doesNotMatch(partial,/bmatrix|frac/u);
  assert.equal((await db.prepare('SELECT count(*) n FROM library_parse_pages WHERE document_id=? AND parser LIKE ?').bind(id,'pdf-ai-formula-v2:%').first<{n:number}>())?.n,0);
  await db.prepare('INSERT INTO library_parse_pages VALUES (?,?,0,?)').bind(id,PDF_PARSER_VERSION,partial).run();
  await db.prepare("UPDATE library_documents SET status='ready' WHERE id=?").bind(id).run();
  assert.equal((await getPdfFormulaReparseStatus(owner,id)).status,'idle','v3-only partial page can use existing manual recovery');
  assert.equal((await queuePdfFormulaReparse(owner,id)).status,'queued');
  assert.equal((await queuePdfFormulaReparse(owner,id)).status,'queued');
  assert.equal((await db.prepare('SELECT count(*) n FROM background_jobs WHERE id=?').bind(`index:${id}`).first<{n:number}>())?.n,1);
  assert.equal((await parsePdfPages(id,bytes))[0].text,partial);assert.equal(calls,1,'ordinary read is zero-request');
  valid=true;const recovered=(await parsePdfPages(id,bytes,true))[0].text;
  assert.equal(calls,2,'one explicit recovery makes one attempt for the page');assert.ok(recovered.startsWith(partial));
  assert.match(recovered,/原告警/u);assert.match(recovered,/部分公式无法可靠识别/u);assert.match(recovered,/请核对原页/u);
  assert.equal(await pdfFormulaPageNeedsRecovery(id,sourceHash,1,recovered),false,'new policy proof resolves this step without deleting history');
  assert.equal((await parsePdfPages(id,bytes,true))[0].text,recovered);assert.equal(calls,2,'matching complete proof never retries');
  assert.equal((await parsePdfPages(id,bytes))[0].text,recovered);assert.equal(calls,2);
  await db.prepare("UPDATE background_jobs SET status='complete' WHERE id=?").bind(`index:${id}`).run();
  assert.equal((await getPdfFormulaReparseStatus(owner,id)).status,'complete');
  // Complete=true cannot turn invalid structure into a successful cache.
  assert.match(appendPdfLatex(base,['\\begin{bmatrix}1'],true),/本页公式识别不完整/u);
 }finally{globalThis.fetch=before;}
});
