import test from 'node:test';
import assert from 'node:assert/strict';
import {PDFDocument,StandardFonts} from 'pdf-lib';
import {appendPdfLatex,mayContainPdfMath,assessPdfFormulaPreservation} from '../lib/pdf-formulas.ts';
process.env.AI_BUDGET_TEST_BYPASS='true';

test('formula character preservation accepts its explicit LaTeX subset without claiming semantic proof',()=>{
 for(const [source,latex]of [
  ['δk′(s,u) + w(u,v) ≤ 10','\\delta_{k^\\prime}(s,u)+\\mathrm{w}(u,v)\\leq10'],
  ['min{{a}∪{b}}','\\min\\left\\{\\{a\\}\\cup\\{b\\}\\right\\}'],
  ['α1+β2=3','\\alpha_{1}+\\beta_{2}=3'],
  ['x ≠ 0','x\\neq0'],
 ])assert.equal(assessPdfFormulaPreservation(source,latex).status,'characters-preserved');
});

test('formula character preservation detects lost primes, literal set scope and changed true numbers; unknown stays unassessed',()=>{
 for(const [source,latex]of [
  ['f′(x)=0','f(x)=0'],
  ['min{{a}∪{b}}','\\min\\{a\\}\\cup\\{b\\}'],
  ['x0=10','x_{\\prime}=10'],
  ['x=2','x=20'],
 ])assert.equal(assessPdfFormulaPreservation(source,latex).status,'changed');
 assert.equal(assessPdfFormulaPreservation('√x','\\sqrt{x}').status,'unassessed');
 assert.equal(assessPdfFormulaPreservation('x','\\unknown{x}').status,'unassessed');
 assert.equal(assessPdfFormulaPreservation('x^2','x^{2}').status,'unassessed');
});

test('formula character preservation rejects TeX comments, parameters and active syntax but retains escaped literals',()=>{
 for(const literal of ['%','#','~'])
  assert.equal(assessPdfFormulaPreservation(`x${literal}1`,`x${literal}1`).status,'unassessed');
 for(const literal of ['%','#'])
  assert.equal(assessPdfFormulaPreservation(`x${literal}1`,`x\\${literal}1`).status,'characters-preserved');
 assert.equal(assessPdfFormulaPreservation('20%x','\\text{20%x}').status,'unassessed');
 assert.equal(assessPdfFormulaPreservation('20%x','\\text{20\\%x}').status,'characters-preserved');
});

test('Docling formula augmentation resumes successful pages without exceeding the per-document cap',async()=>{
 process.env.DATABASE_URL=':memory:';
 const {saveDocument}=await import('../lib/library.ts');
 const {enrichParsedPdfFormulae,PDF_FORMULA_PAGES_PER_DOCUMENT}=await import('../lib/document-parser.ts');
 const pdf=await PDFDocument.create();
 for(let page=0;page<PDF_FORMULA_PAGES_PER_DOCUMENT+1;page++)pdf.addPage();
 const bytes=await pdf.save(),id=await saveDocument('formula-resume','','upload','cache-test','cache-test.pdf','application/pdf',bytes);
 const pages=Array.from({length:PDF_FORMULA_PAGES_PER_DOCUMENT+1},(_,index)=>({pageNumber:index+1,locator:`第 ${index+1} 页`,text:`Original prose ${index}: E = mc2`}));
 const original=globalThis.fetch;let calls=0;
 globalThis.fetch=async()=>{calls++;return Response.json({output_text:JSON.stringify({formulae:['E=mc^{2}'],complete:true})});};
 try{
  const first=await enrichParsedPdfFormulae(id,bytes,pages);
  assert.equal(calls,PDF_FORMULA_PAGES_PER_DOCUMENT);
  assert.equal(first.warnings.length,1);
  assert.ok(first.pages[0].text.startsWith(pages[0].text));
  const resumed=await enrichParsedPdfFormulae(id,bytes,pages);
  assert.equal(calls,PDF_FORMULA_PAGES_PER_DOCUMENT);
  assert.equal(resumed.warnings.length,1);
  assert.match(resumed.pages.at(-1)!.text,/公式识别不完整/);
 }finally{globalThis.fetch=original;}
});

test('math cues select pages without sending ordinary prose for vision',()=>{
 assert.equal(mayContainPdfMath('Lecture notes on campus history.'),false);
 assert.equal(mayContainPdfMath('The equation is E = mc².'),true);
 assert.equal(mayContainPdfMath('Compute the integral of x.'),true);
});

test('LaTeX formulae supplement rather than replace original searchable text',()=>{
 const original='Energy on page one: E = mc²';
 const text=appendPdfLatex(original,['$$E=mc^{2}$$','\\[\\frac{a}{b}\\]'],true);
 assert.ok(text.startsWith(original));
 assert.match(text,/\\\[E=mc\^\{2\}\\\]/u);
 assert.match(text,/\\\[\\frac\{a\}\{b\}\\\]/u);
 assert.equal(appendPdfLatex(original,[],false),original+'\n\n[本页公式识别不完整，请核对原 PDF]');
 assert.match(appendPdfLatex(original,['\u0000'],true),/本页公式识别不完整/u);
});

test('PDF page parsing keeps page locator and asks vision to produce LaTeX',async()=>{
 process.env.DATABASE_URL=':memory:';
 process.env.LOCAL_OCR='false';
 const {database:db}=await import('../lib/database.ts');
 const {saveDocument}=await import('../lib/library.ts');
 const {parsePdfPages,PDF_PARSER_VERSION}=await import('../lib/document-parser.ts');
 const pdf=await PDFDocument.create();const page=pdf.addPage();const font=await pdf.embedFont(StandardFonts.Helvetica);
 page.drawText('E = mc2',{x:40,y:700,size:14,font});
 const bytes=await pdf.save(),id=await saveDocument('math-owner','math','upload','math.pdf','math.pdf','application/pdf',bytes);
 const original=globalThis.fetch;let sawLatexPrompt=false;
 globalThis.fetch=async(_url,init)=>{
  const body=JSON.parse(String(init?.body));
  sawLatexPrompt=JSON.stringify(body.input).includes('LaTeX');
  return Response.json({output_text:JSON.stringify({text:'Energy: \\(E=mc^{2}\\)',complete:true})});
 };
 try{
  const pages=await parsePdfPages(id,bytes);
  assert.equal(sawLatexPrompt,true);
  assert.equal(pages[0]?.locator,'第 1 页');
  assert.match(pages[0]?.text||'',/\\\(E=mc\^\{2\}\\\)/u);
  const stored=await db.prepare('SELECT body FROM library_parse_pages WHERE document_id=? AND parser=? AND page=0').bind(id,PDF_PARSER_VERSION).first<{body:string}>();
  assert.equal(stored?.body,pages[0].text);
 }finally{globalThis.fetch=original;}
});

test('the previous PDF text remains visible while the LaTeX parser reindexes',async()=>{
 process.env.DATABASE_URL=':memory:';
 const {database:db}=await import('../lib/database.ts');
 const {saveDocument,previewDocument}=await import('../lib/library.ts');
 const bytes=Buffer.from('%PDF-1.4 legacy placeholder');
 const id=await saveDocument('formula-owner','math','upload','prior.pdf','prior.pdf','application/pdf',bytes);
 await db.prepare("INSERT INTO library_parse_pages VALUES (?, 'pdf-page-v2', 0, ?)").bind(id,'Original searchable page text').run();
 await db.prepare("UPDATE library_documents SET status='ready' WHERE id=?").bind(id).run();
 const preview=await previewDocument('formula-owner',id);
 assert.equal(preview.pages[0]?.text,'Original searchable page text');
 assert.equal(await db.prepare('SELECT 1 ok FROM background_jobs WHERE id=?').bind(`index:${id}`).first(),null);
 await (await import('../lib/library.ts')).indexDocument('formula-owner',id);
 assert.equal((await db.prepare("SELECT status FROM library_documents WHERE id=?").bind(id).first<{status:string}>())?.status,'ready');
 await db.prepare('INSERT INTO library_parse_pages VALUES (?,?,0,?)').bind(id,'pdf-page-v3-latex','Original searchable page text\n\\[E=mc^{2}\\]').run();
 const updated=await previewDocument('formula-owner',id);
 assert.match(updated.pages[0]?.text||'',/\\\[E=mc\^\{2\}\\\]/u);
});

test('an incomplete legacy PDF retries even when historical backfill is disabled',async()=>{
 process.env.DATABASE_URL=':memory:';
 process.env.LOCAL_OCR='false';
 delete process.env.PDF_FORMULA_BACKFILL;
 const {database:db}=await import('../lib/database.ts');
 const {saveDocument,previewDocument,indexDocument}=await import('../lib/library.ts');
 const {PDF_PARSER_VERSION}=await import('../lib/document-parser.ts');
 const {kernel}=await import('../lib/kernel/service.ts');
 await kernel.upsertCourse({id:'math',name:'Test mathematics',course_code:'MATH'});
 const pdf=await PDFDocument.create();pdf.addPage();pdf.addPage();const bytes=await pdf.save();
 const id=await saveDocument('legacy-retry','math','upload','partial.pdf','partial.pdf','application/pdf',bytes);
 await db.prepare("INSERT INTO library_parse_pages VALUES (?, 'pdf-page-v2', 0, ?)").bind(id,'Legacy page one').run();
 await db.prepare("UPDATE library_documents SET status='error' WHERE id=?").bind(id).run();
 const preview=await previewDocument('legacy-retry',id);
 assert.equal(preview.pages[0]?.text,'Legacy page one');
 assert.ok(await db.prepare('SELECT 1 ok FROM background_jobs WHERE id=?').bind(`index:${id}`).first());
 const original=globalThis.fetch;let calls=0;
 globalThis.fetch=async()=>Response.json({output_text:JSON.stringify({text:`Recovered page ${++calls}`,complete:true})});
 try{await indexDocument('legacy-retry',id);}finally{globalThis.fetch=original;}
 assert.equal(calls,2);
 assert.equal((await db.prepare('SELECT COUNT(*) n FROM library_parse_pages WHERE document_id=? AND parser=?').bind(id,PDF_PARSER_VERSION).first<{n:number}>())?.n,2);
 assert.equal((await db.prepare('SELECT status FROM library_documents WHERE id=?').bind(id).first<{status:string}>())?.status,'ready');
});

test('one owner-scoped click queues one resumable PDF formula job and preserves old text',async()=>{
 process.env.DATABASE_URL=':memory:';
 process.env.LOCAL_OCR='false';
 delete process.env.PDF_FORMULA_BACKFILL;
 const {database:db}=await import('../lib/database.ts');
 const {saveDocument,previewDocument,indexDocument}=await import('../lib/library.ts');
 const {getPdfFormulaReparseStatus,queuePdfFormulaReparse}=await import('../lib/pdf-formula-reparse.ts');
 const {PDF_PARSER_VERSION}=await import('../lib/document-parser.ts');
 const {kernel}=await import('../lib/kernel/service.ts');
 await kernel.upsertCourse({id:'math',name:'Test mathematics',course_code:'MATH'});
 const pdf=await PDFDocument.create();pdf.addPage();pdf.addPage();const bytes=await pdf.save();
 const id=await saveDocument('click-owner','math','upload','formula-old.pdf','formula-old.pdf','application/pdf',bytes);
 await db.prepare("INSERT INTO library_parse_pages VALUES (?, 'pdf-page-v2', 0, ?)").bind(id,'Old page one').run();
 await db.prepare("INSERT INTO library_parse_pages VALUES (?, 'pdf-page-v2', 1, ?)").bind(id,'Old page two').run();
 await db.prepare("UPDATE library_documents SET status='ready' WHERE id=?").bind(id).run();
 await assert.rejects(queuePdfFormulaReparse('other-owner',id));
 assert.equal((await getPdfFormulaReparseStatus('click-owner',id)).status,'idle');
 assert.equal((await queuePdfFormulaReparse('click-owner',id)).status,'queued');
 await db.prepare('UPDATE background_jobs SET attempts=2 WHERE id=?').bind(`index:${id}`).run();
 assert.equal((await queuePdfFormulaReparse('click-owner',id)).status,'queued');
 const job=await db.prepare('SELECT status,attempts,payload FROM background_jobs WHERE id=?').bind(`index:${id}`).first<{status:string;attempts:number;payload:string}>();
 assert.equal(job?.attempts,2);
 assert.equal(JSON.parse(job!.payload).forcePdfFormulaReparse,true);
 await db.prepare("UPDATE background_jobs SET status='running' WHERE id=?").bind(`index:${id}`).run();
 assert.equal((await queuePdfFormulaReparse('click-owner',id)).status,'running');
 await db.prepare("UPDATE background_jobs SET status='failed' WHERE id=?").bind(`index:${id}`).run();
 assert.equal((await getPdfFormulaReparseStatus('click-owner',id)).status,'failed');
 assert.equal((await queuePdfFormulaReparse('click-owner',id)).status,'queued');
 await db.prepare('INSERT INTO library_parse_pages VALUES (?,?,0,?)').bind(id,PDF_PARSER_VERSION,'New page one \\[E=mc^{2}\\]').run();
 await db.prepare("UPDATE background_jobs SET status='running' WHERE id=?").bind(`index:${id}`).run();
 assert.equal((await getPdfFormulaReparseStatus('click-owner',id)).status,'running');
 assert.deepEqual((await previewDocument('click-owner',id)).pages.map(page=>page.text),['Old page one','Old page two']);
 const original=globalThis.fetch;globalThis.fetch=async()=>Response.json({output_text:JSON.stringify({text:'New page two \\[\\frac{a}{b}\\]',complete:true})});
 try{await indexDocument('click-owner',id,true);}finally{globalThis.fetch=original;}
 await db.prepare("UPDATE background_jobs SET status='complete' WHERE id=?").bind(`index:${id}`).run();
 assert.equal((await getPdfFormulaReparseStatus('click-owner',id)).status,'complete');
 assert.match((await previewDocument('click-owner',id)).pages[0]?.text||'',/mc\^\{2\}/u);
 assert.match((await previewDocument('click-owner',id)).pages[1]?.text||'',/\\frac/u);
});

test('a failed manual reparse keeps the ready PDF and old search chunks',async()=>{
 process.env.DATABASE_URL=':memory:';
 process.env.LOCAL_OCR='false';
 const {database:db}=await import('../lib/database.ts');
 const {saveDocument,previewDocument,indexDocument}=await import('../lib/library.ts');
 const {getPdfFormulaReparseStatus,queuePdfFormulaReparse}=await import('../lib/pdf-formula-reparse.ts');
 const pdf=await PDFDocument.create();pdf.addPage();const bytes=await pdf.save();
 const id=await saveDocument('failure-owner','math','upload','failed-old.pdf','failed-old.pdf','application/pdf',bytes);
 await db.prepare("INSERT INTO library_parse_pages VALUES (?, 'pdf-page-v2', 0, ?)").bind(id,'Old searchable text').run();
 await db.prepare('INSERT INTO library_chunks VALUES (?,?,?,?,?,?)').bind(`${id}:0`,id,0,'第 1 页','Old searchable text','old-hash').run();
 await db.prepare("UPDATE library_documents SET status='ready' WHERE id=?").bind(id).run();
 await queuePdfFormulaReparse('failure-owner',id);
 await db.prepare("UPDATE background_jobs SET status='running' WHERE id=?").bind(`index:${id}`).run();
 const original=globalThis.fetch;globalThis.fetch=async()=>{throw new Error('synthetic provider failure');};
 try{await assert.rejects(indexDocument('failure-owner',id,true));}finally{globalThis.fetch=original;}
 await db.prepare("UPDATE background_jobs SET status='failed' WHERE id=?").bind(`index:${id}`).run();
 assert.equal((await db.prepare('SELECT status FROM library_documents WHERE id=?').bind(id).first<{status:string}>())?.status,'ready');
 assert.equal((await db.prepare('SELECT body FROM library_chunks WHERE document_id=?').bind(id).first<{body:string}>())?.body,'Old searchable text');
 assert.equal((await previewDocument('failure-owner',id)).pages[0]?.text,'Old searchable text');
 assert.equal((await getPdfFormulaReparseStatus('failure-owner',id)).status,'failed');
});
