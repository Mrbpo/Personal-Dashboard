import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PDFDocument,PDFName,PDFDict,PDFRawStream,decodePDFRawStream} from 'pdf-lib';

const directory=mkdtempSync(join(tmpdir(),'source-encoding-'));
process.env.DATABASE_URL=':memory:';process.env.LIBRARY_DIR=directory;
after(()=>rmSync(directory,{recursive:true,force:true}));
const name=(value:string)=>PDFName.of(value);
// Synthetic object-level fixture only: no renderer, real glyph-outline or OCR claim.
async function fixture(options:{ambiguous?:boolean;override?:boolean;alreadyCorrect?:boolean|'02B9';duplicateCode?:boolean}={}){
 const pdf=await PDFDocument.create(),page=pdf.addPage([612,792]),context=pdf.context;
 const font=(encoding:string,pairs:string,baseFont:string)=>{
  const program=Buffer.from(`%!PS-AdobeFont-1.0\n/Encoding 256 array\n0 1 255 {1 index exch /.notdef put} for\n${encoding}\nreadonly def\ncurrentfile eexec\n`);
  const file=context.register(context.flateStream(program,{Length1:program.length}));
  const descriptor=context.register(context.obj({Type:'FontDescriptor',FontFile:file}));
  const cmap=Buffer.from(`begincmap\n${pairs.split('\n').length} beginbfchar\n${pairs}\nendbfchar\nendcmap`);
  return context.obj({Type:'Font',Subtype:'Type1',BaseFont:baseFont,FontDescriptor:descriptor,ToUnicode:context.register(context.flateStream(cmap))});
 };
 const source=font(`dup 42 /prime put\ndup 54 /negationslash put${options.duplicateCode?'\ndup 042 /other put':''}`,
  `<2A> <${options.alreadyCorrect==='02B9'?'02B9':options.alreadyCorrect?'2032':'0030'}>\n<36> <${options.alreadyCorrect?'0338':'0036'}>${options.ambiguous?'\n<2B> <0030>':''}`,'ArbitraryNameNotCMSY');
 if(options.override)source.set(name('Encoding'),name('StandardEncoding'));
 const zero=font('dup 48 /zero put\ndup 61 /equal put','<30> <0030>\n<3D> <003D>','AnotherArbitraryName');
 page.node.set(name('Resources'),context.obj({Font:{P:context.register(source),Z:context.register(zero)}}));
 page.node.set(name('Contents'),context.register(context.flateStream(Buffer.from('BT /P 12 Tf (*)Tj (6)Tj /Z 12 Tf (0000000000000)Tj ET'))));
 return pdf.save();
}
async function cmap(bytes:Uint8Array,key:string){
 const pdf=await PDFDocument.load(bytes),font=pdf.getPage(0).node.Resources()!.lookup(name('Font'),PDFDict).lookup(name(key),PDFDict);
 const stream=font.lookup(name('ToUnicode'));assert.ok(stream instanceof PDFRawStream);
 return Buffer.from(decodePDFRawStream(stream).decode()).toString();
}

test('actual embedded glyph names repair arbitrary codes/names; thirteen source zeros and content stay unchanged',async()=>{
 const {prepareSourceFontInput}=await import('../lib/kernel/docling.ts');
 const input=await fixture(),snapshot=Buffer.from(input),result=await prepareSourceFontInput(input);
 assert.deepEqual(Buffer.from(input),snapshot);assert.equal(result.proof?.patches.length,2);
 assert.deepEqual(result.proof!.patches.map(p=>[p.code,p.glyphName]),[[42,'prime'],[54,'negationslash']]);
 assert.match(await cmap(result.bytes,'P'),/<2A> <2032>/);assert.match(await cmap(result.bytes,'P'),/<36> <0338>/);
 assert.equal(await cmap(input,'Z'),await cmap(result.bytes,'Z'));
 const pdf=await PDFDocument.load(result.bytes),contents=pdf.getPage(0).node.Contents() as PDFRawStream;
 const raw=Buffer.from(decodePDFRawStream(contents).decode()).toString();
 assert.match(raw,/\(0000000000000\)Tj/);assert.equal((raw.match(/0/g)||[]).length,13);
});
test('already correct input is byte-for-byte no-op; empty pages are also no-op',async()=>{
 const {prepareSourceFontInput}=await import('../lib/kernel/docling.ts');
 const input=await fixture({alreadyCorrect:true}),result=await prepareSourceFontInput(input);
 assert.equal(result.bytes,input);assert.equal(result.proof,undefined);
 const modifierPrime=await fixture({alreadyCorrect:'02B9'}),accepted=await prepareSourceFontInput(modifierPrime);
 assert.equal(accepted.bytes,modifierPrime);assert.equal(accepted.proof,undefined);
 const pdf=await PDFDocument.create();pdf.addPage();const blank=await pdf.save();
 assert.equal((await prepareSourceFontInput(blank)).bytes,blank);
 const large=await PDFDocument.create(),page=large.addPage(),context=large.context;
 const file=context.register(context.flateStream(Buffer.alloc(2*1024*1024+1,1)));
 const descriptor=context.register(context.obj({FontFile2:file}));
 page.node.set(name('Resources'),context.obj({Font:{T:context.register(context.obj({Subtype:'TrueType',FontDescriptor:descriptor}))}}));
 page.node.set(name('Contents'),context.register(context.flateStream(Buffer.alloc(2*1024*1024+1,32))));
 const largeBytes=await large.save();assert.equal((await prepareSourceFontInput(largeBytes)).bytes,largeBytes);
});
test('ambiguous inverse CMap or overridden Encoding cannot publish a derivative',async()=>{
 const {prepareSourceFontInput}=await import('../lib/kernel/docling.ts');
 for(const opts of [{ambiguous:true},{override:true},{duplicateCode:true}]){
  const input=await fixture(opts),snapshot=Buffer.from(input);
  await assert.rejects(prepareSourceFontInput(input),/needs review/);assert.deepEqual(Buffer.from(input),snapshot);
 }
});
test('proof/input identity is stable and old or mismatched progress cannot be rebound',async()=>{
 const {prepareSourceFontInput}=await import('../lib/kernel/docling.ts');
 const {createDoclingProgress,validateDoclingProgress}=await import('../lib/kernel/docling-batches.ts');
 const {digest}=await import('../lib/library.ts');
 const input=await fixture(),one=await prepareSourceFontInput(input),two=await prepareSourceFontInput(input);
 assert.equal(digest(one.bytes),digest(two.bytes));assert.equal(digest(JSON.stringify(one.proof)),digest(JSON.stringify(two.proof)));
 const identity={owner:'owner',documentId:'doc',sourceHash:digest(input),totalPages:1,optionsHash:'a'.repeat(64),sourceEncodingReceiptHash:digest(JSON.stringify(one.proof))};
 const progress=createDoclingProgress(identity);assert.deepEqual(validateDoclingProgress(progress,identity),progress);
 const {sourceEncodingReceiptHash:_,...old}=identity;
 assert.throws(()=>validateDoclingProgress(progress,old),/identity/);
 assert.throws(()=>validateDoclingProgress(createDoclingProgress(old),identity),/identity/);
 assert.throws(()=>validateDoclingProgress(progress,{...identity,sourceEncodingReceiptHash:'b'.repeat(64)}),/identity/);
 assert.throws(()=>validateDoclingProgress(progress,{...identity,optionsHash:'c'.repeat(64)}),/identity/);
});
