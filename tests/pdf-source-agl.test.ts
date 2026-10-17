import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,relative} from 'node:path';
import {PDFDocument,PDFName,PDFDict,PDFRawStream,decodePDFRawStream} from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import type {PdfFontReferenceDictionary} from '../lib/pdf-source-fidelity.ts';
import {sourcePostAglCandidate,validateSourcePostAgl,type SourcePostFont} from '../lib/pdf-source-agl.ts';

const base=tmpdir(),directory=mkdtempSync(join(base,'source-post-agl-'));
process.env.DATABASE_URL=':memory:';process.env.LIBRARY_DIR=directory;
after(()=>{const r=relative(base,directory);assert.ok(r.startsWith('source-post-agl-')&&!r.includes('..'));rmSync(directory,{recursive:true,force:true});});
const sha=(v:Uint8Array|string)=>createHash('sha256').update(v).digest('hex'),name=(v:string)=>PDFName.of(v);
const asset=JSON.parse(readFileSync(new URL('../lib/assets/source-post-agl-outline-v1.json',import.meta.url),'utf8')) as PdfFontReferenceDictionary;
const command=[{command:'moveTo',args:[1,2]},{command:'lineTo',args:[3,4]}];
const outline=sha(JSON.stringify({unitsPerEm:2048,commands:command}));
const stub=(glyphName='sigma'):SourcePostFont=>({post:{version:2},numGlyphs:2,unitsPerEm:2048,
 getGlyph:gid=>({id:gid,name:glyphName,path:{commands:command}})});
const refs=():PdfFontReferenceDictionary=>({...structuredClone(asset),fonts:[{sha256:'b'.repeat(64),unitsPerEm:2048}],
 sourcePostAgl:{...structuredClone(asset.sourcePostAgl!),outlines:[[outline,2048,0,86]]}});

// Public bundled test font, not a Windows font binary. Isolating its existing
// Mac cmap creates a controlled PDF object fixture, not page-fidelity evidence.
async function fixture(mapping='1 beginbfchar\n<40> <002A>\nendbfchar'){
 const complete=readFileSync(new URL('../node_modules/pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf',import.meta.url)),program=Buffer.from(complete);
 const records=Array.from({length:program.readUInt16BE(4)},(_,i)=>12+i*16),record=records.find(i=>program.toString('ascii',i,i+4)==='cmap')!,offset=program.readUInt32BE(record+8);
 const entries=Array.from({length:program.readUInt16BE(offset+2)},(_,i)=>offset+4+i*8),mac=entries.find(i=>program.readUInt16BE(i)===1&&program.readUInt16BE(i+2)===0)!;
 const sub=offset+program.readUInt32BE(mac+4),part=program.subarray(sub,sub+program.readUInt16BE(sub+2)),cmap=Buffer.alloc(12+part.length);
 assert.ok([0,6].includes(program.readUInt16BE(sub)));cmap.writeUInt16BE(1,2);cmap.writeUInt16BE(1,4);cmap.writeUInt32BE(12,8);part.copy(cmap,12);
 cmap.copy(program,offset);program.writeUInt32BE(cmap.length,record+12);
 const checksum=(data:Buffer)=>{let sum=0;for(let i=0;i<data.length;i+=4){let word=0;for(let j=0;j<4;j++)word=word*256+(data[i+j]??0);sum=(sum+word)>>>0;}return sum;};
 program.writeUInt32BE(checksum(cmap),record+4);const head=records.find(i=>program.toString('ascii',i,i+4)==='head')!,h=program.readUInt32BE(head+8);
 program.writeUInt32BE(0,h+8);program.writeUInt32BE((0xb1b0afba-checksum(program))>>>0,h+8);
 const native=fontkit.create(program) as ReturnType<typeof fontkit.create>&{cmap:{tables:Array<{table:{version:number;codeMap:{get:(i:number)=>number};firstCode:number;glyphIndices:{get:(i:number)=>number}}}>}};
 const table=native.cmap.tables[0].table,gid=table.version===0?table.codeMap.get(64):table.glyphIndices.get(64-table.firstCode),glyph=native.getGlyph(gid);
 assert.equal((glyph as unknown as {name:string}).name,'at');
 const commands=(glyph.path as unknown as {commands:typeof command}).commands.map(c=>({command:c.command,args:[...c.args]}));
 const references:PdfFontReferenceDictionary={...structuredClone(asset),fonts:[{sha256:sha(complete),unitsPerEm:native.unitsPerEm}],
  sourcePostAgl:{...structuredClone(asset.sourcePostAgl!),outlines:[[sha(JSON.stringify({unitsPerEm:native.unitsPerEm,commands})),native.unitsPerEm,0,gid]]}};
 const pdf=await PDFDocument.create(),page=pdf.addPage(),context=pdf.context,file=context.register(context.flateStream(program));
 const descriptor=context.register(context.obj({Flags:4,FontFile2:file})),text=`begincmap\n1 begincodespacerange\n<00> <FF>\nendcodespacerange\n2 beginbfchar\n<2A> <002A>\n<41> <0041>\nendbfchar\n${mapping}\nendcmap`;
 const font=context.obj({Type:'Font',Subtype:'TrueType',BaseFont:'ObjectFixture',FirstChar:42,LastChar:65,FontDescriptor:descriptor,
  ToUnicode:context.register(context.flateStream(Buffer.from(text)))});
 page.node.set(name('Resources'),context.obj({Font:{T:context.register(font)}}));page.node.set(name('Contents'),context.register(context.flateStream(Buffer.from('BT /T 12 Tf (*)Tj (@)Tj (A)Tj ET'))));
 return {bytes:await pdf.save(),references,program,text};
}
async function cmap(bytes:Uint8Array){const pdf=await PDFDocument.load(bytes),font=pdf.getPage(0).node.Resources()!.lookup(name('Font'),PDFDict).lookup(name('T'),PDFDict),stream=font.lookup(name('ToUnicode'));
 assert.ok(stream instanceof PDFRawStream);return Buffer.from(decodePDFRawStream(stream).decode()).toString();}

test('v3 explicit bfchar/singleton bfrange correction is opt-in and preserves all non-target objects',async()=>{
 const {prepareSourceFontInput}=await import('../lib/kernel/docling.ts');
 for(const mapping of ['1 beginbfchar\n<40> <002A>\nendbfchar','1 beginbfrange\n<40> <40> <002A>\nendbfrange']){
  const f=await fixture(mapping),snapshot=Buffer.from(f.bytes);
  for(const policy of ['source-font-reference-v1','source-font-reference-v2'] as const){const old=await prepareSourceFontInput(f.bytes,undefined,f.references,policy);assert.equal(old.bytes,f.bytes);assert.equal(old.proof,undefined);}
  const result=await prepareSourceFontInput(f.bytes,undefined,f.references,'source-font-reference-v3');assert.deepEqual(Buffer.from(f.bytes),snapshot);
  assert.equal(result.proof!.version,'source-font-reference-v3');assert.equal(result.proof!.patches.length,1);const p=result.proof!.patches[0];
  assert.equal(p.code,64);assert.equal(p.reference!.utf16Hex,'0040');assert.equal(p.reference!.sourceMapping.policy,'symbolic-simple-tt-post2-agl-contradiction-v1');
  assert.equal(result.proof!.referenceDictionarySha256,sha(JSON.stringify(f.references)));assert.equal(p.fontFileHash,sha(f.program));
  assert.equal(await cmap(result.bytes),f.text.replace('<002A>\nendbfchar\nendcmap','<0040>\nendbfchar\nendcmap').replace('<002A>\nendbfrange','<0040>\nendbfrange'));
  assert.deepEqual(result.proof!.preserved[0].fontFileHashes,[sha(f.program)]);assert.equal(result.proof!.preserved[0].contentHashes.length,1);
 }
});

test('unknown names, non-post2, same-font or conflicting exact-outline evidence never yield a candidate',()=>{
 const d=refs(),candidate=sourcePostAglCandidate(stub(),1,'a'.repeat(64),d)!;
 assert.equal(candidate.utf16Hex,'03C3');assert.equal(candidate.agl.literal,'sigma;03C3');assert.equal(candidate.agl.line,3559);
 for(const glyphName of ['lscript','not-an-agl-name','sigmasuffix','dalethatafpatah'])assert.equal(sourcePostAglCandidate(stub(glyphName),1,'a'.repeat(64),d),undefined);
 assert.equal(sourcePostAglCandidate({...stub(),post:{version:3}},1,'a'.repeat(64),d),undefined);
 assert.equal(sourcePostAglCandidate(stub(),1,'b'.repeat(64),d),undefined);
 assert.equal(sourcePostAglCandidate({...stub(),unitsPerEm:1000},1,'a'.repeat(64),d),undefined);
 const absent=refs();absent.sourcePostAgl!.outlines[0][0]='c'.repeat(64);assert.equal(sourcePostAglCandidate(stub(),1,'a'.repeat(64),absent),undefined);
 const alias:SourcePostFont={...stub(),numGlyphs:3,getGlyph:gid=>({...stub(gid===1?'sigma':'pi').getGlyph(gid)})};
 assert.equal(sourcePostAglCandidate(alias,1,'a'.repeat(64),d),undefined);
 const conflict=refs();conflict.entries=[[outline,'0073',[0]]];assert.equal(sourcePostAglCandidate(stub(),1,'a'.repeat(64),conflict),undefined);
 const modified=refs();modified.sourcePostAgl!.glyphList+='\n';assert.throws(()=>validateSourcePostAgl(modified),/pinned source/);
});

test('ambiguous/unsupported mappings and already-correct Unicode remain unchanged',async()=>{
 const {prepareSourceFontInput}=await import('../lib/kernel/docling.ts');
 for(const mapping of ['2 beginbfchar\n<40> <002A>\n<40> <002A>\nendbfchar','1 beginbfrange\n<40> <41> <002A>\nendbfrange',
  '1 beginbfrange\n<40> <40> [<002A>]\nendbfrange','1 beginbfchar\n<40> <0040>\nendbfchar','1 beginbfchar\n<40> <002A>\nendbfchar\n/Base usecmap']){
  const f=await fixture(mapping),r=await prepareSourceFontInput(f.bytes,undefined,f.references,'source-font-reference-v3');assert.equal(r.bytes,f.bytes);assert.equal(r.proof,undefined);
 }
});

test('v3 ignores commented and literal-string mapping operators and preserves their original bytes',async()=>{
 const {prepareSourceFontInput}=await import('../lib/kernel/docling.ts');
 const comment='% 1 beginbfchar <40> <002A> endbfchar endcmap usecmap\r\n',
  literal='(ignored \\( nested (1 beginbfchar <40> <002A> endbfchar) percent % escaped \\) text) pop\n';
 const absent=await fixture(comment+comment+literal),none=await prepareSourceFontInput(absent.bytes,undefined,absent.references,'source-font-reference-v3');
 assert.equal(none.bytes,absent.bytes);assert.equal(none.proof,undefined);
 const active='1 beginbfchar\n<40> <002A>\nendbfchar',f=await fixture(comment+literal+active+ '\n'+comment),
  result=await prepareSourceFontInput(f.bytes,undefined,f.references,'source-font-reference-v3');
 assert.equal(result.proof!.patches.length,1);assert.equal(result.proof!.patches[0].code,64);
 assert.equal(await cmap(result.bytes),f.text.replace(active,active.replace('<002A>','<0040>')));
});

test('v3 saved receipt replays its exact source, reference asset and derived parser input; GC retains the declared CAS reference',async()=>{
 const {prepareSourceFontInput}=await import('../lib/kernel/docling.ts'),{createDoclingProgress,parsingProvenanceBlobHashes}=await import('../lib/kernel/docling-batches.ts'),{decodeCachedDoclingReplay}=await import('../lib/kernel/docling-cache-replay.ts');
 const f=await fixture(),result=await prepareSourceFontInput(f.bytes,undefined,f.references,'source-font-reference-v3');
 const assetBytes=Buffer.from(JSON.stringify(f.references)),receipt=Buffer.from(JSON.stringify({kind:result.proof!.version,proof:result.proof}));
 const identity={owner:'post-agl-fixture',documentId:'post-agl-fixture',sourceHash:sha(f.bytes),totalPages:1,optionsHash:'f'.repeat(64),sourceEncodingReceiptHash:sha(receipt)},progress=createDoclingProgress(identity);
 const input=await PDFDocument.create();input.setCreationDate(new Date(0));input.setModificationDate(new Date(0));input.setProducer('Study Kernel Docling derived-v1');input.setCreator('Study Kernel');
 for(const page of await input.copyPages(await PDFDocument.load(result.bytes,{updateMetadata:false}),[0]))input.addPage(page);
 const batch=progress.batches[0];batch.copyIndices=[0];batch.inputHash=sha(await input.save());
 const raw=Buffer.from(JSON.stringify({identity:{...identity,start:1,end:1,inputHash:batch.inputHash,copyIndices:[0]},result:{status:'success',document:{json_content:{pages:{1:{page_no:1}},body:{children:[{$ref:'#/texts/0'}]},texts:[{label:'text',text:'Synthetic @',prov:[{page_no:1}]}]}}}}));
 batch.resultHash=sha(raw);const blobs=new Map([[sha(assetBytes),assetBytes],[sha(receipt),receipt],[sha(raw),raw]]),load=async(h:string)=>{assert.ok(blobs.has(h));return blobs.get(h)!;};
 const replay=await decodeCachedDoclingReplay(f.bytes,identity,progress,load);assert.equal(replay.pages[0].text,'Synthetic @');
 const retained=await parsingProvenanceBlobHashes(progress,identity,load);assert.ok(retained.includes(sha(assetBytes)));assert.ok(retained.includes(sha(receipt)));
 await assert.rejects(decodeCachedDoclingReplay(f.bytes,identity,progress,async h=>h===sha(assetBytes)?Buffer.from('{}'):load(h)),/reference asset checksum/);
});
