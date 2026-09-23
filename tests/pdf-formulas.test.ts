import test from 'node:test';
import assert from 'node:assert/strict';
import {PDFDocument,StandardFonts} from 'pdf-lib';
import {appendPdfLatex,mayContainPdfMath} from '../lib/pdf-formulas.ts';
process.env.AI_BUDGET_TEST_BYPASS='true';

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
 assert.equal(appendPdfLatex(original,['\u0000'],true),original);
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
