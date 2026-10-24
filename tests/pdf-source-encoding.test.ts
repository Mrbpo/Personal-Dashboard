import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PDFDocument,PDFName,PDFDict,PDFArray,PDFRawStream,PDFRef,PDFNull,decodePDFRawStream} from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import type {PdfFontReferenceDictionary} from '../lib/pdf-source-fidelity.ts';

const directory=mkdtempSync(join(tmpdir(),'source-encoding-'));
process.env.DATABASE_URL=':memory:';process.env.LIBRARY_DIR=directory;
after(()=>rmSync(directory,{recursive:true,force:true}));
const name=(value:string)=>PDFName.of(value);
// Synthetic object-level fixture only: no renderer, real glyph-outline or OCR claim.
async function fixture(options:{ambiguous?:boolean;override?:boolean;alreadyCorrect?:boolean|'02B9';duplicateCode?:boolean;acceptedAlias?:boolean}={}){
 const pdf=await PDFDocument.create(),page=pdf.addPage([612,792]),context=pdf.context;
 const font=(encoding:string,pairs:string,baseFont:string)=>{
  const program=Buffer.from(`%!PS-AdobeFont-1.0\n/Encoding 256 array\n0 1 255 {1 index exch /.notdef put} for\n${encoding}\nreadonly def\ncurrentfile eexec\n`);
  const file=context.register(context.flateStream(program,{Length1:program.length}));
  const descriptor=context.register(context.obj({Type:'FontDescriptor',FontFile:file}));
  const cmap=Buffer.from(`begincmap\n${pairs.split('\n').length} beginbfchar\n${pairs}\nendbfchar\nendcmap`);
  return context.obj({Type:'Font',Subtype:'Type1',BaseFont:baseFont,FontDescriptor:descriptor,ToUnicode:context.register(context.flateStream(cmap))});
 };
 const prime=options.alreadyCorrect==='02B9'?'02B9':options.alreadyCorrect?'2032':'0030';
 const source=font(`dup 42 /prime put\ndup 54 /negationslash put${options.duplicateCode?'\ndup 042 /other put':''}${options.acceptedAlias?'\ndup 43 /prime put':''}`,
  `<2A> <${prime}>\n<36> <${options.alreadyCorrect?'0338':'0036'}>${options.ambiguous?'\n<2B> <0030>':''}${options.acceptedAlias?`\n<2B> <${prime}>`:''}`,'ArbitraryNameNotCMSY');
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

test('missing optional Type1 ToUnicode retains original bytes and records unknown mappings without a repair proof',async()=>{
 const {prepareSourceFontInput}=await import('../lib/kernel/docling.ts');
 const pdf=await PDFDocument.load(await fixture()),font=pdf.getPage(0).node.Resources()!.lookup(name('Font'),PDFDict).lookup(name('P'),PDFDict);
 font.delete(name('ToUnicode'));
 const input=await pdf.save(),snapshot=Buffer.from(input),unchangedOtherMap=await cmap(input,'Z');
 const result=await prepareSourceFontInput(input);
 assert.equal(result.bytes,input);assert.deepEqual(Buffer.from(input),snapshot);assert.equal(result.proof,undefined);
 assert.equal(result.observations?.length,1);
 assert.deepEqual(result.observations?.[0],{pageNumber:1,resourceKey:'/P',
  fontFileHash:result.observations![0].fontFileHash,reason:'missing-type1-tounicode',
  declaredTargets:[{code:42,glyphName:'prime'},{code:54,glyphName:'negationslash'}],characterMapping:'unknown',glyphUsage:'unknown'});
 assert.match(result.observations![0].fontFileHash,/^[a-f0-9]{64}$/);
 const selected=await prepareSourceFontInput(input,[0]),copy=await PDFDocument.load(selected.bytes);
 assert.equal(copy.getPage(0).node.Resources()!.lookup(name('Font'),PDFDict).lookup(name('P'),PDFDict).has(name('ToUnicode')),false);
 assert.equal(await cmap(selected.bytes,'Z'),unchangedOtherMap);
 assert.deepEqual(selected.observations,result.observations);assert.equal(selected.proof,undefined);
});

test('present malformed ToUnicode is still rejected rather than treated as absent',async()=>{
 const {prepareSourceFontInput}=await import('../lib/kernel/docling.ts');
 for(const mode of ['oversized','not-stream','dangling','null']){
  const pdf=await PDFDocument.load(await fixture()),font=pdf.getPage(0).node.Resources()!.lookup(name('Font'),PDFDict).lookup(name('P'),PDFDict);
  font.set(name('ToUnicode'),mode==='oversized'?pdf.context.register(pdf.context.flateStream(Buffer.alloc(65537,32))):
   mode==='dangling'?PDFRef.of(900000):mode==='null'?PDFNull:name('InvalidCMap'));
  const input=await pdf.save(),snapshot=Buffer.from(input);
  await assert.rejects(prepareSourceFontInput(input),/needs review/,mode);assert.deepEqual(Buffer.from(input),snapshot);
 }
});

async function singletonRangeFixture(mode='valid',glyph='prime',differenceMode?:string,sourceValue='FFFD'){
 const pdf=await PDFDocument.create(),page=pdf.addPage(),context=pdf.context,code=42;
 const program=Buffer.from(`%!PS-AdobeFont-1.0\n/Encoding 256 array\n0 1 255 {1 index exch /.notdef put} for\ndup ${code} /${glyph} put\nreadonly def\ncurrentfile eexec\n`),
  file=context.register(context.flateStream(program,{Length1:program.length})),descriptor=context.register(context.obj({FontFile:file}));
 const rows=Array.from({length:32},(_,i)=>{const hex=(32+i).toString(16);return `<${hex}> <${hex}> <FFFD>`;});
  rows[code-32]=`<2a> <2a> <${sourceValue}>`;
  if(mode==='scalar-inverse')rows[code-31]=`<2b> <2b> <${sourceValue}>`;
 if(mode==='missing')rows.splice(code-32,1);
 if(mode==='overlap')rows.push('<2a> <2b> <FFFD>');
 if(mode==='duplicate')rows.push('<2a> <2a> <FFFD>');
 if(mode==='nonsingleton')rows.splice(code-32,2,'<2a> <2b> <FFFD>');
 if(mode==='array')rows[code-32]='<2a> <2a> [<FFFD>]';
 if(mode==='outside')rows.push('<40> <40> <FFFD>');
 if(mode==='wide')rows[code-32]='<002a> <002a> <FFFD>';
 if(mode==='bfchar-target')rows.splice(code-32,1);
 const body=`begincmap\n1 begincodespacerange\n<20> <3f>\nendcodespacerange\n${rows.length+(mode==='count'?1:0)} beginbfrange\n${rows.join('\n')}${mode==='junk'?'\nunsupported-token':''}\nendbfrange\n${mode==='bfchar-target'?'1 beginbfchar\n<2a> <FFFD>\nendbfchar\n':''}${mode==='commented-bfchar'?'% 2 beginbfchar\n% <2a> <0030>\n% endbfchar\n':''}${mode==='extra-codespace'?'1 begincodespacerange\n<20> <3f>\nendcodespacerange\n':''}${mode==='usecmap'?'/Unknown usecmap\n':''}endcmap`;
 const source=context.obj({Type:'Font',Subtype:'Type1',BaseFont:'ArbitraryFixtureName',FontDescriptor:descriptor,
  ToUnicode:context.register(context.flateStream(Buffer.from(body)))});
 if(mode==='override')source.set(name('Encoding'),name('StandardEncoding'));
 if(differenceMode){
  const values:Record<string,Array<number|boolean|PDFName>>={match:[42,name(glyph)],implicit:[40,name('other'),name('neighbor'),name(glyph)],
   missing:[41,name('other')],different:[42,name('zero')],duplicate:[42,name(glyph),42,name(glyph)],
   outside:[256,name(glyph)],negative:[-1,name(glyph)],fractional:[42.5,name(glyph)],overrun:[255,name('other'),name(glyph)],
   unknown:[42,true],startName:[name(glyph)],trailing:[42,name(glyph),45],empty:[],
   oversized:Array.from({length:513},()=>42)};
  const value=context.obj({Type:'Encoding',Differences:values[differenceMode]??values.match});
  if(differenceMode==='extra')value.set(name('BaseEncoding'),name('StandardEncoding'));
  if(differenceMode==='no-type')value.delete(name('Type'));
  if(differenceMode==='no-differences')value.delete(name('Differences'));
  source.set(name('Encoding'),differenceMode==='name'?name('StandardEncoding'):value);
 }
 page.node.set(name('Resources'),context.obj({Font:{P:context.register(source)}}));
 page.node.set(name('Contents'),context.register(context.flateStream(Buffer.from('BT /P 12 Tf (*)Tj ET'))));
 return pdf.save();
}

test('bounded singleton placeholder ranges repair only embedded declared glyph destinations and reject unsupported maps',async()=>{
 const {prepareSourceFontInput}=await import('../lib/kernel/docling.ts');
 for(const [glyph,expected]of [['prime','2032'],['negationslash','0338']]){
  const input=await singletonRangeFixture('valid',glyph),snapshot=Buffer.from(input),before=await cmap(input,'P'),result=await prepareSourceFontInput(input);
  assert.deepEqual(Buffer.from(input),snapshot);assert.equal(result.proof?.patches.length,1);
  assert.deepEqual(result.proof!.patches.map(p=>[p.code,p.glyphName]),[[42,glyph]]);
  assert.equal(await cmap(result.bytes,'P'),before.replace('<2a> <2a> <FFFD>',`<2a> <2a> <${expected}>`));
  assert.deepEqual(result.proof!.preserved[0].contentHashes.length,1);
 }
 for(const mode of ['missing','overlap','duplicate','nonsingleton','array','outside','wide','bfchar-target','count','junk','extra-codespace','usecmap','override']){
  const input=await singletonRangeFixture(mode),snapshot=Buffer.from(input);
  await assert.rejects(prepareSourceFontInput(input),/needs review/,mode);assert.deepEqual(Buffer.from(input),snapshot);
 }
});

test('unique scalar singleton destinations repair only literal embedded glyphs without Encoding overrides',async()=>{
 const {prepareSourceFontInput}=await import('../lib/kernel/docling.ts');
 for(const [glyph,sourceValue,expected]of [['prime','0027','2032'],['negationslash','0036','0338']]){
  const input=await singletonRangeFixture('valid',glyph,undefined,sourceValue),snapshot=Buffer.from(input),
   before=await cmap(input,'P'),result=await prepareSourceFontInput(input);
  assert.deepEqual(Buffer.from(input),snapshot);assert.equal(result.proof?.patches.length,1);
  assert.deepEqual(result.proof!.patches.map(p=>[p.code,p.glyphName]),[[42,glyph]]);
  assert.equal(await cmap(result.bytes,'P'),before.replace(`<2a> <2a> <${sourceValue}>`,`<2a> <2a> <${expected}>`));
  assert.equal(result.proof!.preserved[0].contentHashes.length,1);
 }
 for(const [mode,differences,value]of [['scalar-inverse',undefined,'0027'],['valid',undefined,'00610062'],
  ['valid','match','0027'],['override',undefined,'0027']] as const){
  const input=await singletonRangeFixture(mode,'prime',differences,value),snapshot=Buffer.from(input);
  await assert.rejects(prepareSourceFontInput(input),/needs review/,`${mode}/${differences}/${value}`);
  assert.deepEqual(Buffer.from(input),snapshot);
 }
});

test('singleton placeholder accepts only complete explicit matching Differences and ignores commented bfchar examples',async()=>{
 const {prepareSourceFontInput}=await import('../lib/kernel/docling.ts');
 const encodingText=async(bytes:Uint8Array)=>{
  const pdf=await PDFDocument.load(bytes),font=pdf.getPage(0).node.Resources()!.lookup(name('Font'),PDFDict).lookup(name('P'),PDFDict);
  return font.lookup(name('Encoding'),PDFDict).toString();
 };
 for(const [mode,differences]of [['valid','match'],['valid','implicit'],['commented-bfchar','match']]){
  const input=await singletonRangeFixture(mode,'prime',differences),before=Buffer.from(input),oldEncoding=await encodingText(input),
   oldCmap=await cmap(input,'P'),result=await prepareSourceFontInput(input);
  assert.deepEqual(Buffer.from(input),before);assert.equal(result.proof?.patches.length,1);
  assert.equal(await encodingText(result.bytes),oldEncoding,'Differences dictionary is not changed');
  assert.equal(await cmap(result.bytes,'P'),oldCmap.replace('<2a> <2a> <FFFD>','<2a> <2a> <2032>'));
 }
 for(const mode of ['missing','different','duplicate','outside','negative','fractional','overrun','unknown','startName','trailing',
  'empty','oversized','extra','no-type','no-differences','name']){
  const input=await singletonRangeFixture('valid','prime',mode),before=Buffer.from(input);
  await assert.rejects(prepareSourceFontInput(input),/needs review/,mode);assert.deepEqual(Buffer.from(input),before);
 }
 // Matching Differences does not relax the pre-existing bfchar override gate.
 const legacy=await PDFDocument.load(await fixture()),font=legacy.getPage(0).node.Resources()!.lookup(name('Font'),PDFDict).lookup(name('P'),PDFDict);
 font.set(name('Encoding'),legacy.context.obj({Type:'Encoding',Differences:[42,name('prime'),54,name('negationslash')]}));
 await assert.rejects(prepareSourceFontInput(await legacy.save()),/overridden or unsupported Encoding/);
});

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

// Object-level PDF fixture using an installed public test font. Its one existing
// Mac cmap is isolated for the supported symbolic mapping case; no renderer claim.
async function referenceFixture(options:{flags?:number;encoding?:boolean;alreadyMapped?:boolean;competingCmaps?:boolean;rawCode?:number}={}){
 const {digest}=await import('../lib/library.ts');
 const complete=readFileSync(new URL('../node_modules/pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf',import.meta.url)),font=fontkit.create(complete),program=Buffer.from(complete);
 const directory=Array.from({length:program.readUInt16BE(4)},(_,i)=>12+i*16),record=directory.find(i=>program.toString('ascii',i,i+4)==='cmap')!,offset=program.readUInt32BE(record+8);
 const entries=Array.from({length:program.readUInt16BE(offset+2)},(_,i)=>offset+4+i*8),mac=entries.find(i=>program.readUInt16BE(i)===1&&program.readUInt16BE(i+2)===0);
 assert.notEqual(mac,undefined);const sub=offset+program.readUInt32BE(mac!+4),format=program.readUInt16BE(sub);assert.ok([0,4,6].includes(format));
 const part=program.subarray(sub,sub+program.readUInt16BE(sub+2)),cmap=Buffer.alloc(12+part.length);cmap.writeUInt16BE(1,2);cmap.writeUInt16BE(1,4);cmap.writeUInt32BE(12,8);part.copy(cmap,12);
 cmap.copy(program,offset);program.writeUInt32BE(cmap.length,record+12);
 const checksum=(data:Buffer)=>{let sum=0;for(let i=0;i<data.length;i+=4){let word=0;for(let j=0;j<4;j++)word=word*256+(data[i+j]??0);sum=(sum+word)>>>0;}return sum;};
 program.writeUInt32BE(checksum(cmap),record+4);const head=directory.find(i=>program.toString('ascii',i,i+4)==='head')!,headOffset=program.readUInt32BE(head+8);
 program.writeUInt32BE(0,headOffset+8);program.writeUInt32BE((0xb1b0afba-checksum(program))>>>0,headOffset+8);
 const sourceCode=options.rawCode??64,sourceTable=(font as unknown as {cmap:{tables:Array<{platformID:number;encodingID:number;table:{version:number;firstCode:number;glyphIndices:{get:(i:number)=>number};codeMap:{get:(i:number)=>number}}}>}}).cmap.tables.find(t=>t.platformID===1&&t.encodingID===0)!.table;
 assert.ok([0,6].includes(sourceTable.version));const gid=sourceTable.version===0?sourceTable.codeMap.get(sourceCode):sourceTable.glyphIndices.get(sourceCode-sourceTable.firstCode),glyph=font.getGlyph(gid);
 const unicode=font.characterSet.filter(cp=>font.glyphForCodePoint(cp).id===gid);assert.equal(unicode.length,1);
 const targetHex=Buffer.from(String.fromCodePoint(unicode[0]),'utf16le').swap16().toString('hex').toUpperCase(),commands=(glyph.path as unknown as {commands:unknown[]}).commands.map((c:unknown)=>{const item=c as {command:string;args:number[]};return {command:item.command,args:[...item.args]};});
 const references:PdfFontReferenceDictionary={version:'exact-font-reference-v1',witnessSha256:digest('synthetic reference fixture: actual public font cmap'),
  fonts:[{sha256:digest(complete),unitsPerEm:font.unitsPerEm}],mappings:[[0,glyph.id,[{kind:'cmap',codePoint:unicode[0]}]]],
  entries:[[digest(JSON.stringify({unitsPerEm:font.unitsPerEm,commands})),targetHex,[0]]]};
 const pdf=await PDFDocument.create(),page=pdf.addPage(),context=pdf.context;
 const file=context.register(context.flateStream(options.competingCmaps?complete:program,{Length1:program.length})),descriptor=context.register(context.obj({Type:'FontDescriptor',Flags:options.flags??4,FontFile2:file}));
 const text=`begincmap\n1 begincodespacerange\n<00> <FF>\nendcodespacerange\n${options.alreadyMapped?3:2} beginbfchar\n<2A> <002A>\n<41> <0041>${options.alreadyMapped?'\n<40> <002A>':''}\nendbfchar\nendcmap`;
 const f=context.obj({Type:'Font',Subtype:'TrueType',BaseFont:'SyntheticSymbolicTest',FirstChar:42,LastChar:Math.max(65,sourceCode),FontDescriptor:descriptor,ToUnicode:context.register(context.flateStream(Buffer.from(text)))});
 if(options.encoding)f.set(name('Encoding'),name('MacRomanEncoding'));
 page.node.set(name('Resources'),context.obj({Font:{T:context.register(f)}}));page.node.set(name('Contents'),context.register(context.flateStream(Buffer.from('BT /T 12 Tf (*)Tj (@)Tj (A)Tj ET'))));
 return {bytes:await pdf.save(),references,sourceCode,targetHex};
}

async function cidFixture(options:{encoding?:string;cidMap?:'absent'|'stream';mapped?:boolean;duplicate?:boolean;range?:boolean}={}){
 const f=await referenceFixture(),program=readFileSync(new URL('../node_modules/pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf',import.meta.url)),gid=f.references.mappings[0][1],code=gid.toString(16).padStart(4,'0').toUpperCase();
 const pdf=await PDFDocument.create(),page=pdf.addPage(),context=pdf.context,file=context.register(context.flateStream(program)),descriptor=context.register(context.obj({Flags:4,FontFile2:file}));
 const childMap='begincmap\n1 beginbfchar\n<0001> <002A>\nendbfchar\nendcmap',child=context.obj({Type:'Font',Subtype:'CIDFontType2',FontDescriptor:descriptor,ToUnicode:context.register(context.flateStream(Buffer.from(childMap)))});
 if(options.cidMap!=='absent')child.set(name('CIDToGIDMap'),options.cidMap==='stream'?context.register(context.flateStream(Buffer.from([0,0,0,1]))):name('Identity'));
 const text=`begincmap\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n${options.duplicate?4:3} beginbfchar\n<0001> <002A>\n<0002> <0041>\n<${code}> <${options.mapped?'002A':'FFFD'}>${options.duplicate?`\n<${code}> <FFFD>`:''}\nendbfchar\n${options.range?'1 beginbfrange\n<00F0> <00F0> <0041>\nendbfrange\n':''}endcmap`;
 const parent=context.obj({Type:'Font',Subtype:'Type0',Encoding:options.encoding??'Identity-H',DescendantFonts:[context.register(child)],ToUnicode:context.register(context.flateStream(Buffer.from(text)))});
 page.node.set(name('Resources'),context.obj({Font:{C:context.register(parent)}}));page.node.set(name('Contents'),context.register(context.flateStream(Buffer.from(`BT /C 12 Tf <0001${code}> Tj ET`))));
 return {bytes:await pdf.save(),references:f.references,gid,code,program,childMap};
}

test('CID v2 replaces only the uniquely proven FFFD bfchar in place and preserves descendant programs and maps',async()=>{
 const {prepareSourceFontInput}=await import('../lib/kernel/docling.ts'),{digest}=await import('../lib/library.ts');const f=await cidFixture();
 const result=await prepareSourceFontInput(f.bytes,undefined,f.references,'source-font-reference-v2');assert.equal(result.proof!.version,'source-font-reference-v2');
 assert.equal(result.proof!.patches.length,1);assert.equal(result.proof!.patches[0].code,f.gid);assert.equal(result.proof!.patches[0].reference!.sourceMapping.policy,'identity-h-cidfonttype2-explicit-identity-v1');
 const changed=await cmap(result.bytes,'C');assert.equal((changed.match(new RegExp(`<${f.code}>`,'g'))||[]).length,1);assert.match(changed,new RegExp(`<${f.code}> <0040>`));
 assert.match(changed,/<0001> <002A>/);assert.match(changed,/<0002> <0041>/);assert.ok(!changed.includes('FFFD'));assert.match(changed,/3 beginbfchar/);
 assert.deepEqual(result.proof!.preserved[0].fontFileHashes,[digest(f.program)]);assert.deepEqual(result.proof!.preserved[0].unmodifiedCmapHashes,[digest(f.childMap)]);assert.equal(result.proof!.preserved[0].fontMappingHashes!.length,2);
 const parsed=await PDFDocument.load(result.bytes),parent=parsed.getPage(0).node.Resources()!.lookup(name('Font'),PDFDict).lookup(name('C'),PDFDict),child=parent.lookup(name('DescendantFonts'),PDFArray).lookup(0,PDFDict),descriptor=child.lookup(name('FontDescriptor'),PDFDict),font=descriptor.lookup(name('FontFile2'));assert.ok(font instanceof PDFRawStream);
 assert.equal(digest(decodePDFRawStream(font).decode()),digest(f.program));assert.equal(String(child.lookup(name('CIDToGIDMap'))),'/Identity');
 const childMap=child.lookup(name('ToUnicode'));assert.ok(childMap instanceof PDFRawStream);assert.equal(Buffer.from(decodePDFRawStream(childMap).decode()).toString(),f.childMap);
});
test('CID recovery refuses non-Identity, valid mapped values and unproven duplicate or ranged CMaps',async()=>{
 const {prepareSourceFontInput}=await import('../lib/kernel/docling.ts');
 for(const options of [{encoding:'Identity-V'},{cidMap:'absent' as const},{cidMap:'stream' as const},{mapped:true},{duplicate:true},{range:true}]){
  const f=await cidFixture(options),result=await prepareSourceFontInput(f.bytes,undefined,f.references,'source-font-reference-v2');assert.equal(result.bytes,f.bytes);assert.equal(result.proof,undefined);
 }
});
test('mixed simple-TT and CID history replays v1 without new descendant fields or CID repairs; new v2 binds them',async()=>{
 const {prepareSourceFontInput}=await import('../lib/kernel/docling.ts'),{digest}=await import('../lib/library.ts'),tt=await referenceFixture(),cid=await cidFixture(),source=await PDFDocument.create();
 for(const bytes of [tt.bytes,cid.bytes])for(const page of await source.copyPages(await PDFDocument.load(bytes),[0]))source.addPage(page);const original=await source.save();
 const legacy=await prepareSourceFontInput(original,undefined,tt.references,'source-font-reference-v1'),current=await prepareSourceFontInput(original,undefined,tt.references,'source-font-reference-v2');
 assert.equal(legacy.proof!.patches.length,1);assert.equal(legacy.proof!.version,'source-font-reference-v1');assert.deepEqual(legacy.proof!.preserved[1].fontFileHashes,[]);assert.equal(legacy.proof!.preserved[1].fontMappingHashes,undefined);
 const legacyPdf=await PDFDocument.load(legacy.bytes),legacyFont=legacyPdf.getPage(1).node.Resources()!.lookup(name('Font'),PDFDict).lookup(name('C'),PDFDict),legacyCmap=legacyFont.lookup(name('ToUnicode'));assert.ok(legacyCmap instanceof PDFRawStream);assert.match(Buffer.from(decodePDFRawStream(legacyCmap).decode()).toString(),/FFFD/);
 assert.equal(current.proof!.patches.length,2);assert.equal(current.proof!.version,'source-font-reference-v2');assert.deepEqual(current.proof!.preserved[1].fontFileHashes,[digest(cid.program)]);
 const {createDoclingProgress}=await import('../lib/kernel/docling-batches.ts'),{decodeCachedDoclingReplay}=await import('../lib/kernel/docling-cache-replay.ts');
 for(const prepared of [legacy,current]){
  const asset=Buffer.from(JSON.stringify(tt.references)),receipt=Buffer.from(JSON.stringify({kind:prepared.proof!.version,proof:prepared.proof})),identity={owner:'mixed-history',documentId:'mixed',sourceHash:digest(original),totalPages:2,optionsHash:'f'.repeat(64),sourceEncodingReceiptHash:digest(receipt)},progress=createDoclingProgress(identity,2),input=await PDFDocument.create();
  input.setCreationDate(new Date(0));input.setModificationDate(new Date(0));input.setProducer('Study Kernel Docling derived-v1');input.setCreator('Study Kernel');
  for(const page of await input.copyPages(await PDFDocument.load(prepared.bytes,{updateMetadata:false}),[0,1]))input.addPage(page);
  const batch=progress.batches[0];batch.copyIndices=[0,1];batch.inputHash=digest(await input.save());
  const raw=Buffer.from(JSON.stringify({identity:{...identity,start:1,end:2,inputHash:batch.inputHash,copyIndices:[0,1]},result:{status:'success',document:{json_content:{pages:{1:{page_no:1},2:{page_no:2}},body:{children:[{$ref:'#/texts/0'},{$ref:'#/texts/1'}]},texts:[{label:'text',text:'Synthetic simple TT',prov:[{page_no:1}]},{label:'text',text:'Synthetic CID',prov:[{page_no:2}]}]}}}}));
  batch.resultHash=digest(raw);const blobs=new Map([[digest(asset),asset],[digest(receipt),receipt],[digest(raw),raw]]),replayed=await decodeCachedDoclingReplay(original,identity,progress,async h=>{assert.ok(blobs.has(h));return blobs.get(h)!;});assert.equal(replayed.pages.length,2);
 }
});

test('reference recovery fills only proven missing simple-TT codes and replays the exact CAS dictionary',async()=>{
 const {prepareSourceFontInput}=await import('../lib/kernel/docling.ts'),{digest}=await import('../lib/library.ts');
 const f=await referenceFixture(),result=await prepareSourceFontInput(f.bytes,undefined,f.references),asset=Buffer.from(JSON.stringify(f.references));
 assert.equal(result.proof?.version,'source-font-reference-v1');assert.equal(result.proof!.patches.length,1);
 assert.equal(result.proof!.patches[0].code,64);assert.equal(result.proof!.referenceDictionarySha256,digest(asset));
 assert.match(await cmap(result.bytes,'T'),/<40> <0040>/);assert.match(await cmap(result.bytes,'T'),/<2A> <002A>/);assert.match(await cmap(result.bytes,'T'),/<41> <0041>/);
 const high=await referenceFixture({rawCode:128}),highResult=await prepareSourceFontInput(high.bytes,undefined,high.references);
 assert.equal(highResult.proof!.patches[0].code,128);assert.equal(highResult.proof!.patches[0].reference!.utf16Hex,high.targetHex);
 const {createDoclingProgress}=await import('../lib/kernel/docling-batches.ts'),{decodeCachedDoclingReplay}=await import('../lib/kernel/docling-cache-replay.ts');
 const receipt=Buffer.from(JSON.stringify({kind:result.proof!.version,proof:result.proof})),identity={owner:'reference-owner',documentId:'reference-doc',sourceHash:digest(f.bytes),totalPages:1,optionsHash:'a'.repeat(64),sourceEncodingReceiptHash:digest(receipt)},progress=createDoclingProgress(identity);
 const input=await PDFDocument.create();input.setCreationDate(new Date(0));input.setModificationDate(new Date(0));input.setProducer('Study Kernel Docling derived-v1');input.setCreator('Study Kernel');
 for(const page of await input.copyPages(await PDFDocument.load(result.bytes,{updateMetadata:false}),[0]))input.addPage(page);
 const batch=progress.batches[0];batch.copyIndices=[0];batch.inputHash=digest(await input.save());
 const raw=Buffer.from(JSON.stringify({identity:{...identity,start:1,end:1,inputHash:batch.inputHash,copyIndices:[0]},result:{status:'success',document:{json_content:{pages:{1:{page_no:1}},body:{children:[{$ref:'#/texts/0'}]},texts:[{label:'text',text:'Synthetic @ and *',orig:'Synthetic @ and *',prov:[{page_no:1}]}]}}}}));
 batch.resultHash=digest(raw);const blobs=new Map([[digest(asset),asset],[digest(receipt),receipt],[digest(raw),raw]]),load=async(h:string)=>{assert.ok(blobs.has(h));return blobs.get(h)!;};
 const replay=await decodeCachedDoclingReplay(f.bytes,identity,progress,load);assert.equal(replay.pages[0].text,'Synthetic @ and *');
 await assert.rejects(decodeCachedDoclingReplay(f.bytes,identity,progress,async h=>h===digest(asset)?Buffer.from('wrong asset'):load(h)),/reference asset checksum/);
});
test('reference matching preserves existing values and refuses Encoding/Flags/cmap ambiguity or conflicting reference sequences',async()=>{
 const {prepareSourceFontInput,validateFontReferenceDictionary}=await import('../lib/kernel/docling.ts');
 for(const options of [{alreadyMapped:true},{flags:32},{flags:36},{encoding:true},{competingCmaps:true}]){
  const f=await referenceFixture(options),result=await prepareSourceFontInput(f.bytes,undefined,f.references);assert.equal(result.bytes,f.bytes);assert.equal(result.proof,undefined);
 }
 const f=await referenceFixture(),conflict=structuredClone(f.references);conflict.entries.push([conflict.entries[0][0],'0041',[0]]);
 assert.throws(()=>validateFontReferenceDictionary(conflict),/Ambiguous or invalid/);
 assert.equal((await prepareSourceFontInput(f.bytes)).bytes,f.bytes);
});
test('already correct input is byte-for-byte no-op; empty pages are also no-op',async()=>{
 const {prepareSourceFontInput}=await import('../lib/kernel/docling.ts');
 const input=await fixture({alreadyCorrect:true}),result=await prepareSourceFontInput(input);
 assert.equal(result.bytes,input);assert.equal(result.proof,undefined);
 const modifierPrime=await fixture({alreadyCorrect:'02B9'}),accepted=await prepareSourceFontInput(modifierPrime);
 assert.equal(accepted.bytes,modifierPrime);assert.equal(accepted.proof,undefined);
 for(const alreadyCorrect of [true,'02B9'] as const){
  const aliases=await fixture({alreadyCorrect,acceptedAlias:true}),noop=await prepareSourceFontInput(aliases);
  assert.equal(noop.bytes,aliases);assert.equal(noop.proof,undefined);
 }
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
 const receipt=Buffer.from(JSON.stringify({kind:one.proof!.version,proof:one.proof}));
 const identity={owner:'owner',documentId:'doc',sourceHash:digest(input),totalPages:1,optionsHash:'a'.repeat(64),sourceEncodingReceiptHash:digest(receipt)};
 const progress=createDoclingProgress(identity);assert.deepEqual(validateDoclingProgress(progress,identity),progress);
 const {sourceEncodingReceiptHash:_,...old}=identity;
 assert.throws(()=>validateDoclingProgress(progress,old),/identity/);
 assert.throws(()=>validateDoclingProgress(createDoclingProgress(old),identity),/identity/);
 assert.throws(()=>validateDoclingProgress(progress,{...identity,sourceEncodingReceiptHash:'b'.repeat(64)}),/identity/);
 assert.throws(()=>validateDoclingProgress(progress,{...identity,optionsHash:'c'.repeat(64)}),/identity/);
 // Rebuild the same actual parser input before accepting cached Docling output.
 const {decodeCachedDoclingReplay}=await import('../lib/kernel/docling-cache-replay.ts');
 const parserPdf=await PDFDocument.load(one.bytes,{updateMetadata:false}),derived=await PDFDocument.create();
 derived.setCreationDate(new Date(0));derived.setModificationDate(new Date(0));
 derived.setProducer('Study Kernel Docling derived-v1');derived.setCreator('Study Kernel');
 for(const page of await derived.copyPages(parserPdf,[0]))derived.addPage(page);
 const batch=progress.batches[0];batch.inputHash=digest(await derived.save());batch.copyIndices=[0];
 const text='prime ′; equality =\u0338; zeros 0000000000000';
 const raw=Buffer.from(JSON.stringify({identity:{...identity,start:1,end:1,inputHash:batch.inputHash,copyIndices:[0]},
  result:{status:'success',document:{json_content:{pages:{1:{page_no:1}},body:{children:[{$ref:'#/texts/0'}]},
   texts:[{label:'text',text,orig:text,prov:[{page_no:1}]}]}}}}));
 batch.resultHash=digest(raw);const blobs=new Map([[identity.sourceEncodingReceiptHash,receipt],[batch.resultHash,raw]]);
 const load=async(hash:string)=>{assert.ok(blobs.has(hash));return blobs.get(hash)!;};
 const replay=await decodeCachedDoclingReplay(input,identity,progress,load);
 assert.equal(replay.pages[0].text,text.normalize('NFC'));assert.equal(replay.progress.identity.sourceEncodingReceiptHash,identity.sourceEncodingReceiptHash);
 await assert.rejects(decodeCachedDoclingReplay(input,identity,progress,async hash=>hash===identity.sourceEncodingReceiptHash?Buffer.from('corrupt'):load(hash)),/receipt checksum/);
 const forged=Buffer.from(JSON.stringify({kind:one.proof!.version,proof:{...one.proof,inputHash:'0'.repeat(64)}}));
 const forgedIdentity={...identity,sourceEncodingReceiptHash:digest(forged)},forgedProgress={...progress,identity:forgedIdentity};
 await assert.rejects(decodeCachedDoclingReplay(input,forgedIdentity,forgedProgress,async()=>forged),/proof or input mismatch/);
 const wrongBatch=structuredClone(progress);wrongBatch.batches[0].inputHash=digest(input);
 await assert.rejects(decodeCachedDoclingReplay(input,identity,wrongBatch,load),/derived input identity mismatch/);
});
