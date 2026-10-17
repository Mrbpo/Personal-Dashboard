import { database as legacy } from '../database.ts';
import { PDFArray, PDFDocument, PDFName, PDFStream, PDFRawStream, PDFDict, PDFNumber, decodePDFRawStream } from 'pdf-lib';
import {readFile,stat} from 'node:fs/promises';
import fontkit from '@pdf-lib/fontkit';
import type {PdfSourceEncodingProof,PdfFontReferenceDictionary} from '../pdf-source-fidelity.ts';
import {SOURCE_POST_AGL_POLICY,validateSourcePostAgl,sourcePostAglCandidate,sourceCmapLexicalView,replaceSingleCmapDestination,type SourcePostFont} from '../pdf-source-agl.ts';
import { digest, getDocument, readBlob, splitText } from '../library.ts';
import { kernel } from './service.ts';
import { decodeDoclingResult, DOCLING_PARSER_VERSION, DOCLING_TEXT_PARSER_VERSION, DOCLING_NUL_PROJECTION_VERSION } from './docling-result.ts';
import {rememberDoclingTask,doclingJobPayload,rememberDoclingProgress} from './jobs.ts';
import {convertDoclingBatches,requestDoclingResult,storeDoclingResult,type DoclingProgress,type DecodedDocling} from './docling-batches.ts';
import {preparePdfVisualEvidence} from './pdf-visual-evidence.ts';
import {enrichParsedPdfFormulae,transcribePdfVisualPages} from '../document-parser.ts';
import {localPdfTextPages} from '../local-ocr.ts';
import {prepareNativeTableCandidates} from './document-table-candidates.ts';
import {bindDoclingSourceMath,prepareDoclingSourceMath} from './docling-source-math.ts';

const SOURCE_ENCODING_VERSION='source-type1-cmap-v1' as const;
// These names come from the actual embedded Encoding, never a font-name/slot heuristic.
const glyphUnicode={prime:{hex:'2032',accepted:['2032','02B9'] as readonly string[],source:'https://github.com/mozilla/pdf.js/blob/master/src/core/glyphlist.js'},
 negationslash:{hex:'0338',accepted:['0338'] as readonly string[],source:'https://github.com/kohler/lcdf-typetools/blob/master/texglyphlist.txt'}} as const;
const encodingReview=(reason:string):never=>{throw new Error(`Source font encoding needs review; original version retained: ${reason}`);};
const referenceVersion='source-font-reference-v1' as const,referenceCidVersion='source-font-reference-v2' as const,
 hexSha=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const unicodeHex=(values:number[])=>Buffer.from(String.fromCodePoint(...values),'utf16le').swap16().toString('hex').toUpperCase();
/** Administrator-generated, content-pinned asset; never inferred from a query or PDF name. */
export function validateFontReferenceDictionary(value:unknown):PdfFontReferenceDictionary{
 const d=value as PdfFontReferenceDictionary,integer=(v:unknown,max=65535):v is number=>Number.isInteger(v)&&Number(v)>=0&&Number(v)<=max,
  codepoint=(v:unknown):v is number=>integer(v,0x10ffff)&&!(Number(v)>=0xd800&&Number(v)<=0xdfff);
 if(!d||d.version!=='exact-font-reference-v1'||!hexSha(d.witnessSha256)||!Array.isArray(d.fonts)||!d.fonts.length||d.fonts.length>16||
  d.fonts.some(f=>!f||!hexSha(f.sha256)||!integer(f.unitsPerEm)||f.unitsPerEm<1)||!Array.isArray(d.mappings)||d.mappings.length>16384||
  !Array.isArray(d.entries)||d.entries.length>8192)throw Error('Invalid bounded font reference asset');
 const sequences=d.mappings.map(m=>{
  if(!Array.isArray(m)||m.length!==3||!integer(m[0],d.fonts.length-1)||!integer(m[1])||!Array.isArray(m[2])||!m[2].length||m[2].length>16)throw Error('Invalid font reference provenance');
  const options=m[2].map(p=>{
   if(p?.kind==='cmap'&&codepoint(p.codePoint))return unicodeHex([p.codePoint]);
   if(p?.kind!=='GSUB-ligature'||![p.lookupIndex,p.subtableIndex,p.coverageIndex].every(n=>integer(n))||![4,7].includes(p.lookupType)||p.effectiveType!==4||
    p.outputGlyphId!==m[1]||!Array.isArray(p.features)||p.features.some(f=>typeof f!=='string'||!/^[\x20-\x7e]{4}$/.test(f))||
    !Array.isArray(p.componentGlyphIds)||p.componentGlyphIds.length<2||p.componentGlyphIds.length>8||p.componentGlyphIds.some(g=>!integer(g))||
    !Array.isArray(p.componentUnicodeOptions)||p.componentUnicodeOptions.length!==p.componentGlyphIds.length||p.componentUnicodeOptions.some(a=>!Array.isArray(a)||a.length!==1||!codepoint(a[0])))throw Error('Unproven font reference sequence');
   return unicodeHex(p.componentUnicodeOptions.map(a=>a[0]));
  });if(new Set(options).size!==1)throw Error('Ambiguous font reference provenance');return options[0];
 });
 const keys=new Set<string>();for(const e of d.entries){
  if(!Array.isArray(e)||e.length!==3||!hexSha(e[0])||keys.has(e[0])||typeof e[1]!=='string'||!/^(?:[0-9A-F]{4}){1,16}$/.test(e[1])||
   !Array.isArray(e[2])||!e[2].length||e[2].length>32||new Set(e[2]).size!==e[2].length||e[2].some(i=>!integer(i,d.mappings.length-1)||sequences[i]!==e[1]))throw Error('Ambiguous or invalid font reference entry');keys.add(e[0]);
 }validateSourcePostAgl(d);return d;
}
async function configuredFontReferences(){
 const path=process.env.PDF_FONT_REFERENCE_DICTIONARY,pin=process.env.PDF_FONT_REFERENCE_DICTIONARY_SHA256;
 if(!path&&!pin)return undefined;if(!path||!hexSha(pin))throw Error('Font reference path and SHA256 must both be configured');
 if((await stat(path)).size>2*1024*1024)throw Error('Configured font reference asset exceeds limit');
 const bytes=await readFile(path);if(bytes.length>2*1024*1024||digest(bytes)!==pin)throw Error('Configured font reference asset checksum/size mismatch');
 return validateFontReferenceDictionary(JSON.parse(bytes.toString('utf8')));
}
function referenceCmap(text:string,options:{boundedSingleByte?:boolean}={}){
 const bounded=options.boundedSingleByte,spaces=[...text.matchAll(/(\d+)\s+begincodespacerange\b([\s\S]*?)\bendcodespacerange/g)],
  space=bounded&&spaces.length===1?/^\s*<([\da-f]{2})>\s*<([\da-f]{2})>\s*$/i.exec(spaces[0][2]):null,
  low=space?parseInt(space[1],16):0,high=space?parseInt(space[2],16):255;
 const chars=[...text.matchAll(/(\d+)\s+beginbfchar\b([\s\S]*?)\bendbfchar/g)],
  ranges=[...text.matchAll(/(\d+)\s+beginbfrange\b([\s\S]*?)\bendbfrange/g)];
 if(bounded){
  if(text.length>65536||!space||Number(spaces[0][1])!==1||high<low||
   (text.match(/\bbegincmap\b/g)||[]).length!==1||(text.match(/\bendcmap\b/g)||[]).length!==1||
   /\busecmap\b|\b(?:begin|end)(?!cmap\b|codespacerange\b|bfchar\b|bfrange\b)[a-z]+\b/.test(text))throw Error('Unsupported bounded source code space');
  const start=text.indexOf('begincmap'),end=text.indexOf('endcmap');
  for(const [kind,blocks]of [['codespacerange',spaces],['bfchar',chars],['bfrange',ranges]] as const){
   if((text.match(new RegExp(`\\bbegin${kind}\\b`,'g'))||[]).length!==blocks.length||
    (text.match(new RegExp(`\\bend${kind}\\b`,'g'))||[]).length!==blocks.length||
    blocks.some(b=>b.index!<start||b.index!+b[0].length>end))throw Error('Incomplete bounded source CMap');
  }
 }
 const entries=new Map<number,string>(),put=(code:number,value:string)=>{
  const hex=value.replace(/\s/g,'').toUpperCase();
  if(code>255||entries.has(code)||bounded&&(code<low||code>high||!/^(?:[\dA-F]{4}){1,16}$/.test(hex)||
   !Buffer.from(hex,'hex').swap16().toString('utf16le').isWellFormed()))throw Error('Unsupported source CMap');entries.set(code,hex);
 };
 if(!bounded&&(!/1\s+begincodespacerange\s*<00>\s*<ff>\s*endcodespacerange/i.test(text)||(text.match(/\bendcmap\b/g)||[]).length!==1))throw Error('Unsupported source code space');
 for(const b of chars){
  const pattern=/<([\da-f]+)>\s*<([\da-f\s]+)>/gi,pairs=[...b[2].matchAll(pattern)];
  if(pairs.length!==+b[1]||bounded&&(b[2].replace(pattern,'').trim()||pairs.some(p=>p[1].length!==2)))throw Error('Unsupported source bfchar');
  for(const p of pairs)put(parseInt(p[1],16),p[2]);
 }
 for(const b of ranges){
  const pattern=/<([\da-f]+)>\s*<([\da-f]+)>\s*<([\da-f]+)>/gi,ranges=[...b[2].matchAll(pattern)];
  if(ranges.length!==+b[1]||bounded&&(b[2].replace(pattern,'').trim()||ranges.some(r=>r[1].length!==2||r[2].length!==2||r[3].length>64)))throw Error('Unsupported source bfrange');
  for(const r of ranges){const start=parseInt(r[1],16),end=parseInt(r[2],16);if(end<start||end>255)throw Error('Unsupported source range');
   for(let code=start;code<=end;code++){const value=(BigInt('0x'+r[3])+BigInt(code-start)).toString(16).padStart(r[3].length,'0');
    if(bounded&&value.length!==r[3].length)throw Error('Overflowing source range');put(code,value);}}
 }if(!entries.size)throw Error('Missing source CMap');return entries;
}

export type PdfSourceFontObservation={pageNumber:number;resourceKey:string;fontFileHash:string;
 reason:'missing-type1-tounicode';declaredTargets:Array<{code:number;glyphName:string}>;
 characterMapping:'unknown';glyphUsage:'unknown'};
/** @internal Pure server-side input preparation; no I/O, OCR, model, CAS or publication. */
export async function prepareSourceFontInput(bytes:Uint8Array,selected?:number[],references?:PdfFontReferenceDictionary,
 referencePolicy:typeof referenceVersion|typeof referenceCidVersion|typeof SOURCE_POST_AGL_POLICY=referenceVersion):Promise<{bytes:Uint8Array;proof?:PdfSourceEncodingProof;observations?:PdfSourceFontObservation[]}>{
 const observations:PdfSourceFontObservation[]=[];
 if(references)validateFontReferenceDictionary(references);
 const referenceHash=references?digest(JSON.stringify(references)):undefined,referenceIndex=new Map(references?.entries.map(e=>[e[0],e])??[]);
 const sourceHash=digest(bytes),original=await PDFDocument.load(bytes,{updateMetadata:false});
 const indices=selected??Array.from({length:original.getPageCount()},(_,i)=>i);
 if(!indices.length||new Set(indices).size!==indices.length||indices.some(i=>!Number.isInteger(i)||i<0||i>=original.getPageCount()))
  throw new Error('Invalid source font input page mapping');
 const decode=(stream:unknown)=>{if(!(stream instanceof PDFRawStream))return encodingReview('expected embedded stream');
  return Buffer.from(decodePDFRawStream(stream).decode());};
 const lookup=(doc:PDFDocument,value:unknown)=>value===undefined?undefined:doc.context.lookup(value as never);
 const descendants=(doc:PDFDocument,font:PDFDict):PDFDict[]=>{
  const value=lookup(doc,font.get(PDFName.of('DescendantFonts')));if(value===undefined)return [];
  if(!(value instanceof PDFArray))return encodingReview('invalid descendant fonts');return value.asArray().map(ref=>{
   const child=lookup(doc,ref);return child instanceof PDFDict?child:encodingReview('invalid descendant font');});
 };
 const fontPrograms=(doc:PDFDocument,font:PDFDict,includeDescendants:boolean)=>[font,...(includeDescendants?descendants(doc,font):[])].flatMap(f=>{
  const descriptor=lookup(doc,f.get(PDFName.of('FontDescriptor')));
  return descriptor instanceof PDFDict?['FontFile','FontFile2','FontFile3'].flatMap(field=>{
   const stream=lookup(doc,descriptor.get(PDFName.of(field)));return stream===undefined?[]:[digest(decode(stream))];}):[];
 });
 const descendantCmaps=(doc:PDFDocument,font:PDFDict)=>descendants(doc,font).map(child=>{
  const value=lookup(doc,child.get(PDFName.of('ToUnicode')));return value===undefined?null:digest(decode(value));});
 const cidMappings=(doc:PDFDocument,font:PDFDict)=>String(font.get(PDFName.of('Subtype')))!=='/Type0'?[]:
  [font,...descendants(doc,font)].map(f=>digest(JSON.stringify(['Encoding','CIDToGIDMap'].map(field=>{
   const value=lookup(doc,f.get(PDFName.of(field)));return value===undefined?null:value instanceof PDFName?value.toString():
    value instanceof PDFRawStream?digest(decode(value)):encodingReview('unsupported CID mapping preservation');
  }))));
 // This deliberately does not resolve any BaseEncoding. Each name in a
 // Differences sequence explicitly assigns the current code, then advances it.
 const explicitType1Differences=(doc:PDFDocument,font:PDFDict)=>{
  const encoding=lookup(doc,font.get(PDFName.of('Encoding')));
  if(!(encoding instanceof PDFDict)||encoding.keys().length!==2||encoding.keys().some(k=>!['/Type','/Differences'].includes(k.toString()))||
   String(lookup(doc,encoding.get(PDFName.of('Type'))))!=='/Encoding')encodingReview('unsupported Type1 Differences dictionary');
  const differences=lookup(doc,(encoding as PDFDict).get(PDFName.of('Differences')));
  if(!(differences instanceof PDFArray)||!differences.size()||differences.size()>512)encodingReview('unbounded or missing Type1 Differences');
  const mapped=new Map<number,string>(),sequence:Array<number|string>=[];let code:number|undefined,pending=false;
  for(const raw of (differences as PDFArray).asArray()){
   const item=lookup(doc,raw);
   if(item instanceof PDFNumber){const value=item.asNumber();
    if(pending||!Number.isInteger(value)||value<0||value>255)encodingReview('invalid Type1 Differences code');
    code=value;pending=true;sequence.push(value);
   }else if(item instanceof PDFName){const glyph=item.decodeText();
    if(code===undefined||code>255||mapped.has(code)||!glyph||glyph.length>127||!/^[A-Za-z0-9_.]+$/.test(glyph))encodingReview('ambiguous Type1 Differences name');
    mapped.set(code!,glyph);sequence.push(glyph);code=code!+1;pending=false;
   }else encodingReview('unsupported Type1 Differences item');
  }
  if(pending)encodingReview('incomplete Type1 Differences sequence');
  return {mapped,hash:digest(JSON.stringify({type:'Encoding',differences:sequence}))};
 };
 type Plan={index:number;key:string;encodingHash?:string;patch:PdfSourceEncodingProof['patches'][number]};
 const plans:Plan[]=[],preserved:PdfSourceEncodingProof['preserved']=[];
 for(const index of indices){
  const page=original.getPage(index);
  const fonts=lookup(original,page.node.Resources()?.get(PDFName.of('Font')));
  for(const [key,ref] of fonts instanceof PDFDict?fonts.entries():[]){
   const font=lookup(original,ref);if(!(font instanceof PDFDict))continue;
   if(String(font.get(PDFName.of('Subtype')))==='/Type0'&&references&&(referencePolicy===referenceCidVersion||referencePolicy===SOURCE_POST_AGL_POLICY)){
    // This is a CID-to-GID proof, not the simple-TT raw-cmap rule. Repair only
    // explicit replacement placeholders, never legitimate mapped Unicode.
    try{
     if(String(font.get(PDFName.of('Encoding')))!=='/Identity-H')continue;
     const children=descendants(original,font);if(children.length!==1)continue;const child=children[0];
     if(String(child.get(PDFName.of('Subtype')))!=='/CIDFontType2'||String(child.get(PDFName.of('CIDToGIDMap')))!=='/Identity')continue;
     const descriptor=lookup(original,child.get(PDFName.of('FontDescriptor'))),fileStream=descriptor instanceof PDFDict?lookup(original,descriptor.get(PDFName.of('FontFile2'))):undefined,
      cmap=lookup(original,font.get(PDFName.of('ToUnicode')));
     if(!(fileStream instanceof PDFRawStream)||!(cmap instanceof PDFRawStream)||fileStream.getContentsSize()>2*1024*1024||cmap.getContentsSize()>65536)continue;
     const file=decode(fileStream),before=decode(cmap);if(file.length>4*1024*1024||before.length>65536)continue;
     const text=before.toString('latin1');if(!/1\s+begincodespacerange\s*<0000>\s*<FFFF>\s*endcodespacerange/i.test(text)||/\b(?:beginbfrange|usecmap)\b/.test(text)||
      (text.match(/\bbegincodespacerange\b/g)||[]).length!==1||(text.match(/\bendcmap\b/g)||[]).length!==1)continue;
     const blocks=[...text.matchAll(/(\d+)\s+beginbfchar\b([\s\S]*?)\bendbfchar/g)],pairs=blocks.flatMap(b=>{
      const values=[...b[2].matchAll(/<([\da-f]{4})>\s*<((?:[\da-f]{4}\s*)+)>/gi)];if(values.length!==Number(b[1]))throw Error('Unproven CID bfchar');return values;});
     if(!pairs.length||new Set(pairs.map(p=>parseInt(p[1],16))).size!==pairs.length)continue;
     const native=fontkit.create(file),changed:PdfSourceEncodingProof['patches']=[];let after=text;
     for(const pair of pairs){
      if(pair[2].replace(/\s/g,'').toUpperCase()!=='FFFD')continue;const code=parseInt(pair[1],16);if(code<1||code>=native.numGlyphs)continue;
      const glyph=native.getGlyph(code),commands=(glyph.path as unknown as {commands:Array<{command:string;args:number[]}>}).commands.map(c=>({command:c.command,args:[...c.args]}));
      if(!commands.length||commands.length>10000||commands.some(c=>c.args.some(n=>!Number.isFinite(n))))continue;
      const pathSha256=digest(JSON.stringify({unitsPerEm:native.unitsPerEm,commands})),entry=referenceIndex.get(pathSha256);
      if(!entry||(entry[1].match(/.{4}/g)||[]).some(hex=>hex==='FFFD')||entry[2].some(i=>references.fonts[references.mappings[i][0]].unitsPerEm!==native.unitsPerEm))continue;
      const replacement=pair[0].replace(/<[\da-f\s]+>$/i,`<${entry[1]}>`);if(after.indexOf(pair[0])!==after.lastIndexOf(pair[0]))throw Error('Ambiguous CID mapping bytes');after=after.replace(pair[0],replacement);
      changed.push({pageNumber:index+1,resourceKey:key.toString(),fontFileHash:digest(file),code,unicodeSource:`font-reference:${referenceHash}`,
       beforeCmapHex:before.toString('hex'),afterCmapHex:'',beforeCmapHash:digest(before),afterCmapHash:'',
       reference:{dictionarySha256:referenceHash!,pathSha256,glyphId:code,unitsPerEm:native.unitsPerEm,utf16Hex:entry[1],mappingIndices:[...entry[2]],
        sourceMapping:{policy:'identity-h-cidfonttype2-explicit-identity-v1',encoding:'Identity-H',cidToGid:'Identity',codeBytes:2,cid:code,sourceUnicodeHex:'FFFD'}}});
     }
     for(const patch of changed){const value=Buffer.from(after,'latin1');patch.afterCmapHex=value.toString('hex');patch.afterCmapHash=digest(value);plans.push({index,key:key.toString(),patch});}
    }catch{/* Unproven CID inputs keep their original mappings for review. */}
    continue;
   }
   if(String(font.get(PDFName.of('Subtype')))==='/TrueType'&&references){
    // PDF.js' symbolic/simple-TT branch uses raw codes for a single Mac cmap.
    // Encoding overrides, non-symbolic fonts and competing cmap choices are not guessed.
    try{
     const descriptor=lookup(original,font.get(PDFName.of('FontDescriptor'))),flags=descriptor instanceof PDFDict?descriptor.lookup(PDFName.of('Flags')):undefined;
     const first=font.lookup(PDFName.of('FirstChar')),last=font.lookup(PDFName.of('LastChar'));
     if(!(descriptor instanceof PDFDict)||!(flags instanceof PDFNumber)||!Number.isSafeInteger(flags.asNumber())||flags.asNumber()<0||
      !(flags.asNumber()&4)||(flags.asNumber()&32)||font.has(PDFName.of('Encoding'))||!(first instanceof PDFNumber)||!(last instanceof PDFNumber)||
      !Number.isInteger(first.asNumber())||!Number.isInteger(last.asNumber())||first.asNumber()<0||last.asNumber()>255||last.asNumber()<first.asNumber())continue;
     const stream=lookup(original,descriptor.get(PDFName.of('FontFile2'))),cmap=lookup(original,font.get(PDFName.of('ToUnicode')));
     if(!(stream instanceof PDFRawStream)||!(cmap instanceof PDFRawStream)||stream.getContentsSize()>2*1024*1024||cmap.getContentsSize()>65536)continue;
     const file=decode(stream),before=decode(cmap);if(file.length>4*1024*1024||before.length>65536)continue;
     const native=fontkit.create(file) as ReturnType<typeof fontkit.create>&{cmap:{tables:Array<{platformID:number;encodingID:number;
      table:{version:number;codeMap:{get:(i:number)=>number};firstCode:number;glyphIndices:{length:number;get:(i:number)=>number}}}>}};
     if(native.cmap.tables.length!==1||native.cmap.tables[0].platformID!==1||native.cmap.tables[0].encodingID!==0)continue;
     const table=native.cmap.tables[0].table;if(table.version!==0&&table.version!==6)continue;
     const originalText=before.toString('latin1'),lexical=referencePolicy===SOURCE_POST_AGL_POLICY?sourceCmapLexicalView:(value:string)=>value,
      text=lexical(originalText),mapped=referenceCmap(text),added:PdfSourceEncodingProof['patches']=[],changed:PdfSourceEncodingProof['patches']=[];
     let after=originalText;const corrected=new Map<number,string>();
     if(referencePolicy===SOURCE_POST_AGL_POLICY&&references.sourcePostAgl&&(/\busecmap\b/.test(text)||(text.match(/\bbegincodespacerange\b/g)||[]).length!==1))continue;
     for(let code=first.asNumber();code<=last.asNumber();code++){
      if(mapped.has(code)&&(referencePolicy!==SOURCE_POST_AGL_POLICY||!references.sourcePostAgl))continue;
      // Read the actual raw cmap slot: glyphForCodePoint may re-encode MacRoman
      // and is not a general PDF raw-byte-to-GID API, especially above 0x7f.
      const offset=code-table.firstCode,gid=table.version===0?table.codeMap.get(code):offset>=0&&offset<table.glyphIndices.length?table.glyphIndices.get(offset):0;
      if(!Number.isInteger(gid)||gid<1||gid>=native.numGlyphs)continue;const glyph=native.getGlyph(gid);
      if(mapped.has(code)){
       const current=mapped.get(code)!;
       if(referencePolicy!==SOURCE_POST_AGL_POLICY||!references.sourcePostAgl||!/^[0-9A-F]{4}$/.test(current))continue;
       const candidate=sourcePostAglCandidate(native as unknown as SourcePostFont,gid,digest(file),references);
       if(!candidate||candidate.utf16Hex===current)continue;
       const replacement=replaceSingleCmapDestination(after,code,current,candidate.utf16Hex);if(replacement===undefined)continue;
       after=replacement;corrected.set(code,candidate.utf16Hex);
       changed.push({pageNumber:index+1,resourceKey:key.toString(),fontFileHash:digest(file),code,unicodeSource:`font-reference:${referenceHash}`,
        beforeCmapHex:before.toString('hex'),afterCmapHex:'',beforeCmapHash:digest(before),afterCmapHash:'',
        reference:{dictionarySha256:referenceHash!,pathSha256:candidate.pathSha256,glyphId:gid,unitsPerEm:native.unitsPerEm,utf16Hex:candidate.utf16Hex,mappingIndices:[],
         sourceMapping:{policy:'symbolic-simple-tt-post2-agl-contradiction-v1',flags:flags.asNumber(),encodingAbsent:true,platformID:1,encodingID:0,format:table.version,
          sourceUnicodeHex:current,postVersion:2,glyphName:candidate.glyphName,agl:candidate.agl,outlineWitnesses:candidate.outlineWitnesses}}});
       continue;
      }
      const commands=(glyph.path as unknown as {commands:Array<{command:string;args:number[]}>}).commands.map(c=>({command:c.command,args:[...c.args]}));
      if(!commands.length||commands.length>10000||commands.some(c=>c.args.some(n=>!Number.isFinite(n))))continue;
      const pathSha256=digest(JSON.stringify({unitsPerEm:native.unitsPerEm,commands})),entry=referenceIndex.get(pathSha256);
      if(!entry||entry[2].some(i=>references.fonts[references.mappings[i][0]].unitsPerEm!==native.unitsPerEm))continue;
      added.push({pageNumber:index+1,resourceKey:key.toString(),fontFileHash:digest(file),code,unicodeSource:`font-reference:${referenceHash}`,
       beforeCmapHex:before.toString('hex'),afterCmapHex:'',beforeCmapHash:digest(before),afterCmapHash:'',
       reference:{dictionarySha256:referenceHash!,pathSha256,glyphId:glyph.id,unitsPerEm:native.unitsPerEm,utf16Hex:entry[1],mappingIndices:[...entry[2]],
        sourceMapping:{policy:'symbolic-simple-tt-single-mac-cmap-v1',flags:flags.asNumber(),encodingAbsent:true,platformID:1,encodingID:0,format:table.version}}});
     }
     if(added.length||changed.length){const suffix=added.map(p=>`<${p.code.toString(16).padStart(2,'0').toUpperCase()}> <${p.reference!.utf16Hex}>`).join('\n'),
       end=/\bendcmap\b/.exec(lexical(after))!.index,
       value=Buffer.from(added.length?after.slice(0,end)+`${added.length} beginbfchar\n${suffix}\nendbfchar\n`+after.slice(end):after,'latin1'),verified=referenceCmap(lexical(value.toString('latin1')));
      if(verified.size!==mapped.size+added.length||[...mapped].some(([c,v])=>verified.get(c)!==(corrected.get(c)??v)))continue;
      for(const patch of [...changed,...added]){patch.afterCmapHex=value.toString('hex');patch.afterCmapHash=digest(value);plans.push({index,key:key.toString(),patch});}
     }
    }catch{/* Unsupported/ambiguous font evidence retains its original mapping. */}
    continue;
   }
   if(String(font.get(PDFName.of('Subtype')))!=='/Type1')continue;
   const descriptor=lookup(original,font.get(PDFName.of('FontDescriptor')));
   const stream=descriptor instanceof PDFDict?lookup(original,descriptor.get(PDFName.of('FontFile'))):undefined;
   if(!(stream instanceof PDFRawStream))continue;
   const length=stream.dict.lookup(PDFName.of('Length1'));
   if(!(length instanceof PDFNumber)||length.asNumber()<1||length.asNumber()>65536)continue;
   const file={data:decode(stream)};
   if(file.data.length>2*1024*1024||length.asNumber()>file.data.length)continue;
   const clear=file.data.subarray(0,length.asNumber()).toString('latin1');
   const encoding=/\/Encoding\s+256\s+array\s+0\s+1\s+255\s+\{\s*1\s+index\s+exch\s+\/\.notdef\s+put\s*\}\s+for([\s\S]*?)readonly\s+def/.exec(clear);
   if(!encoding){if(/\/(prime|negationslash)\b/.test(clear))encodingReview('nonliteral Type1 Encoding');continue;}
   const declared=[...encoding[1].matchAll(/dup\s+(\d+)\s+\/([A-Za-z0-9_.]+)\s+put/g)];
   const targets=declared.filter(m=>Object.hasOwn(glyphUnicode,m[2]));
   if(!targets.length)continue;
   const rawCmap=font.get(PDFName.of('ToUnicode'),true);
   // ToUnicode is optional for simple fonts (PDF Reference 5.9.1). Its absence
   // is not a contradictory mapping to repair. Keep the input byte-for-byte;
   // record uncertainty instead of manufacturing a CMap or rejecting all prose.
   if(rawCmap===undefined){
    observations.push({pageNumber:index+1,resourceKey:key.toString(),fontFileHash:digest(file.data),
     reason:'missing-type1-tounicode',declaredTargets:targets.map(m=>({code:Number(m[1]),glyphName:m[2]})),
     characterMapping:'unknown',glyphUsage:'unknown'});
    continue;
   }
   // Present null, dangling references and invalid objects are malformed, not
   // absent optional entries. They must retain the original rejection path.
   const cmapBytes=decode(lookup(original,rawCmap));
   if(cmapBytes.length>65536)encodingReview('bounded ToUnicode');
   const cmapText=cmapBytes!.toString('latin1');
   const view=sourceCmapLexicalView(cmapText),ranged=/\bbeginbfrange\b/.test(view);
   let bounded:Map<number,string>|undefined;
   if(ranged)try{bounded=referenceCmap(view,{boundedSingleByte:true});}catch{encodingReview('unsupported bounded Type1 CMap');}
   const pairs=ranged?[]:[...cmapText.matchAll(/(\d+)\s+beginbfchar\b([\s\S]*?)\bendbfchar/g)].flatMap(block=>{
    const matches=[...block[2].matchAll(/<([0-9a-f]+)>\s*<([0-9a-f]+)>/gi)];
    if(matches.length!==Number(block[1]))encodingReview('bfchar count mismatch');return matches;});
   type Type1Correction={code:number;glyphName:keyof typeof glyphUnicode;current:RegExpExecArray|undefined;value:string;singletonPlaceholder:boolean};
   const corrections=targets.flatMap<Type1Correction>(target=>{
    const code=Number(target[1]),glyphName=target[2] as keyof typeof glyphUnicode;
    const current=pairs.filter(m=>parseInt(m[1],16)===code);
    if(ranged){
     const value=bounded!.get(code);if(value===undefined)encodingReview('missing source CMap code');
     if(glyphUnicode[glyphName].accepted.includes(value!))return [];
     const singletonPlaceholder=value==='FFFD';
     // Placeholders need unique source position; a non-placeholder must also
     // decode to one scalar and have a unique inverse across the complete map.
     if(!singletonPlaceholder&&([...Buffer.from(value!,'hex').swap16().toString('utf16le')].length!==1||
      [...bounded!.values()].filter(v=>v===value).length!==1))encodingReview('nonunique or nonscalar Type1 range destination');
     if(replaceSingleCmapDestination(cmapText,code,value!,glyphUnicode[glyphName].hex)===undefined||
      ![...view.matchAll(/\d+\s+beginbfrange\b([\s\S]*?)\bendbfrange/g)].some(block=>
        [...block[1].matchAll(/<([\da-f]{2})>\s*<([\da-f]{2})>\s*<([\da-f\s]+)>/gi)].some(m=>
         parseInt(m[1],16)===code&&parseInt(m[2],16)===code&&m[3].replace(/\s/g,'').toUpperCase()===value)))
      encodingReview('unsupported Type1 range target');
     return [{code,glyphName,current:undefined,value:value!,singletonPlaceholder}];
    }
    if(current.length!==1)encodingReview('nonunique source CMap code');
    const value=current[0][2].toUpperCase();
    return glyphUnicode[glyphName].accepted.includes(value)?[]:[{code,glyphName,current:current[0],value,singletonPlaceholder:false}];
   });
   if(!corrections.length)continue; // Legal aliases require no rewrite proof.
   if(encoding[1].replace(/dup\s+\d+\s+\/[A-Za-z0-9_.]+\s+put/g,'').trim())encodingReview('overridden or unsupported Encoding');
   let encodingHash:string|undefined;
   if(font.has(PDFName.of('Encoding'))){
    if(corrections.some(c=>!c.singletonPlaceholder))encodingReview('overridden or unsupported Encoding');
    const explicit=explicitType1Differences(original,font);
    if(corrections.some(c=>explicit.mapped.get(c.code)!==c.glyphName))encodingReview('unproven Type1 Differences target');
    encodingHash=explicit.hash;
   }
   if(declared.some(m=>!Number.isSafeInteger(Number(m[1]))||Number(m[1])<0||Number(m[1])>255)||
    new Set(declared.map(m=>Number(m[1]))).size!==declared.length)encodingReview('duplicate or invalid character code');
   if(new Set(targets.map(m=>m[2])).size!==targets.length)encodingReview('nonunique glyph code');
   if(!ranged&&/beginbfrange/.test(cmapText))encodingReview('unsupported CMap ranges');
   let after=cmapText;
   for(const {code,glyphName,current,value} of corrections){
    if(ranged){
     const replacement=replaceSingleCmapDestination(after,code,value,glyphUnicode[glyphName].hex);
     if(replacement===undefined)encodingReview('nonunique Type1 singleton destination');after=replacement!;
    }else{
     if(pairs.filter(m=>m[2].toUpperCase()===value).length!==1)encodingReview('nonunique inverse CMap value');
     const literal=current![0];if(after.indexOf(literal)!==after.lastIndexOf(literal))encodingReview('nonunique CMap bytes');
     after=after.replace(literal,literal.replace(/<[0-9a-f]+>$/i,`<${glyphUnicode[glyphName].hex}>`));
    }
    plans.push({index,key:key.toString(),...(encodingHash?{encodingHash}:{}),patch:{pageNumber:index+1,resourceKey:key.toString(),fontFileHash:digest(file.data),code,glyphName,
     unicodeSource:glyphUnicode[glyphName].source,beforeCmapHex:cmapBytes!.toString('hex'),afterCmapHex:'',beforeCmapHash:digest(cmapBytes!),afterCmapHash:''}});
   }
   if(bounded){
    const verified=referenceCmap(sourceCmapLexicalView(after),{boundedSingleByte:true}),corrected=new Map(corrections.map(c=>[c.code,glyphUnicode[c.glyphName].hex]));
    if(verified.size!==bounded.size||[...bounded].some(([code,value])=>verified.get(code)!==(corrected.get(code)??value)))encodingReview('non-target Type1 mapping changed');
   }
   if(after!==cmapText)for(const plan of plans.filter(p=>p.index===index&&p.key===key.toString())){
    const data=Buffer.from(after,'latin1');plan.patch.afterCmapHex=data.toString('hex');plan.patch.afterCmapHash=digest(data);
   }
  }
 }
 if(!plans.length&&selected===undefined)return {bytes,...(observations.length?{observations}:{})};
 const includeDescendants=(referencePolicy===referenceCidVersion||referencePolicy===SOURCE_POST_AGL_POLICY)&&plans.some(p=>p.patch.reference);
 // Only a real derivative needs full-object preservation hashing. Unrelated PDFs
 // keep their original bytes without decoding large content or TrueType programs.
 for(const index of indices){
  const page=original.getPage(index),contents=page.node.Contents();
  const streams=contents instanceof PDFArray?contents.asArray().map(r=>lookup(original,r)):[contents];
  const contentHashes=streams.filter(s=>s!==undefined).map(s=>digest(decode(s)));
  const fonts=lookup(original,page.node.Resources()?.get(PDFName.of('Font'))),fontFileHashes:string[]=[],unmodifiedCmapHashes:string[]=[],fontMappingHashes:string[]=[];
  for(const [key,ref] of fonts instanceof PDFDict?fonts.entries():[]){
   const font=lookup(original,ref);if(!(font instanceof PDFDict))continue;
   fontFileHashes.push(...fontPrograms(original,font,includeDescendants));
   if(includeDescendants){unmodifiedCmapHashes.push(...descendantCmaps(original,font).filter((h):h is string=>h!==null));fontMappingHashes.push(...cidMappings(original,font));}
   const cmap=lookup(original,font.get(PDFName.of('ToUnicode')));
   if(cmap!==undefined&&!plans.some(p=>p.index===index&&p.key===key.toString()))unmodifiedCmapHashes.push(digest(decode(cmap)));
  }
  preserved.push({pageNumber:index+1,contentHashes,fontFileHashes,unmodifiedCmapHashes,...(includeDescendants?{fontMappingHashes}:{})});
 }
 const derived=await PDFDocument.create();derived.setCreationDate(new Date(0));derived.setModificationDate(new Date(0));
 derived.setProducer('Study Kernel source encoding input-v1');derived.setCreator('Study Kernel');
 for(const page of await derived.copyPages(original,indices))derived.addPage(page);
 for(const plan of plans){
  const fonts=derived.getPage(indices.indexOf(plan.index)).node.Resources()!.lookup(PDFName.of('Font'),PDFDict);
  const font=fonts.lookup(PDFName.of(plan.key.slice(1)),PDFDict),before=decode(lookup(derived,font.get(PDFName.of('ToUnicode'))));
  if(digest(before)===plan.patch.afterCmapHash)continue; // A shared original font may occur on several copied pages.
  if(digest(before)!==plan.patch.beforeCmapHash)encodingReview('copied font input changed');
  font.set(PDFName.of('ToUnicode'),derived.context.register(derived.context.flateStream(Buffer.from(plan.patch.afterCmapHex,'hex'))));
 }
 for(const [local,index] of indices.entries()){
  const page=derived.getPage(local),contents=page.node.Contents();
  const streams=contents instanceof PDFArray?contents.asArray().map(r=>lookup(derived,r)):[contents];
  if(JSON.stringify(streams.filter(s=>s!==undefined).map(s=>digest(decode(s))))!==JSON.stringify(preserved[local].contentHashes))
   encodingReview('page content changed while copying');
  const beforeFonts=lookup(original,original.getPage(index).node.Resources()?.get(PDFName.of('Font')));
  const afterFonts=lookup(derived,page.node.Resources()?.get(PDFName.of('Font')));
  for(const [key,ref] of beforeFonts instanceof PDFDict?beforeFonts.entries():[]){
   const before=lookup(original,ref),after=afterFonts instanceof PDFDict?lookup(derived,afterFonts.get(key)):undefined;
   if(!(before instanceof PDFDict)||!(after instanceof PDFDict))encodingReview('copied font unavailable');
   if(JSON.stringify(fontPrograms(original,before as PDFDict,includeDescendants))!==JSON.stringify(fontPrograms(derived,after as PDFDict,includeDescendants)))encodingReview('FontFile changed');
   if(includeDescendants&&(JSON.stringify(cidMappings(original,before as PDFDict))!==JSON.stringify(cidMappings(derived,after as PDFDict))||
    JSON.stringify(descendantCmaps(original,before as PDFDict))!==JSON.stringify(descendantCmaps(derived,after as PDFDict))))encodingReview('descendant or CID mapping changed');
   const sourceMap=lookup(original,(before as PDFDict).get(PDFName.of('ToUnicode'))),newMap=lookup(derived,(after as PDFDict).get(PDFName.of('ToUnicode')));
   const patch=plans.find(p=>p.index===index&&p.key===key.toString());
   if(patch?.encodingHash&&explicitType1Differences(derived,after as PDFDict).hash!==patch.encodingHash)encodingReview('Type1 Differences changed while copying');
   if(sourceMap!==undefined&&(newMap===undefined||digest(decode(newMap))!==(patch?.patch.afterCmapHash??digest(decode(sourceMap)))))
    encodingReview('non-target CMap or corrected destination changed');
  }
 }
 const result=await derived.save();
 const referenceUsed=plans.some(p=>p.patch.reference);
 return {bytes:result,...(observations.length?{observations}:{}),...(plans.length?{proof:{version:referenceUsed?referencePolicy:SOURCE_ENCODING_VERSION,sourceHash,copyIndices:indices,inputHash:digest(result),
  ...(referenceUsed?{referenceDictionarySha256:referenceHash}:{}),patches:plans.map(p=>p.patch),preserved}}:{})};
}

export function nativePdfTextIsComplete(pages:string[]|null,expectedPages:number,blankPages:number[]=[]):boolean{
  if(!pages||pages.length!==expectedPages)return false;
  const fingerprint=(line:string)=>line.toLowerCase().replace(/\d+/g,'#').replace(/\s+/g,' ').trim();
  const repeated=new Map<string,number>();
  for(const page of pages){
    const lines=page.split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
    for(const key of new Set([...lines.slice(0,3),...lines.slice(-3)].map(fingerprint)))
      repeated.set(key,(repeated.get(key)||0)+1);
  }
  // Repeated headers/footer labels may exceed 300 characters on four-up scans.
  // Count unique prose, rather than accepting the size of those repeated labels.
  const meaningful=pages.map(page=>page.split(/\r?\n/).filter(line=>
    (repeated.get(fingerprint(line))||0)<Math.max(2,Math.ceil(expectedPages*.6))).join('\n').replace(/\s+/g,' ').trim());
  return meaningful.every((page,index)=>page.length>=40||blankPages.includes(index+1))&&
    meaningful.filter(page=>page.length>=300).length>expectedPages*.5;
}

export async function convertDocumentWithDocling(owner: string, id: string, job?:{id:string;leaseToken:string;taskId?:string;formulaEnriched?:boolean;formulaBackend?:string;scanBackend?:string;progress?:unknown;sourceHash?:string},savedResult?:Record<string,unknown>,savedTaskId?:string): Promise<void> {
  const base=process.env.DOCLING_URL;
  if(!base)throw new Error('DOCLING_URL is required for v1 PDF parsing');
  const document=await getDocument(owner,id);
  if(document.mime!=='application/pdf')return;
  const bytes=await readBlob(document.hash);
  if(digest(bytes)!==document.hash)throw new Error('Original PDF checksum mismatch');
  const expectedCurrentVersion=process.env.KERNEL_DATABASE_URL?await kernel.documentIngestionHead(owner,id,document.hash):undefined;
  const payload=job?await doclingJobPayload(job.id,job.leaseToken):undefined;
  if(payload&&(payload.owner!==owner||payload.id!==id||
    (payload.sourceHash!==undefined&&payload.sourceHash!==document.hash)))throw new Error('PDF ingestion source identity mismatch');
  if(job?.sourceHash&&job.sourceHash!==document.hash)throw new Error('PDF ingestion source identity mismatch');
  const progress=payload?.doclingProgress??job?.progress;
  const legacyTaskId=job?.taskId??(payload?.doclingTaskId as string|undefined)??savedTaskId;
  const originalPdf=await PDFDocument.load(bytes,{updateMetadata:false});
  const originalPages=originalPdf.getPageCount();
  if(originalPages>500)throw new Error('PDF 超过 500 页，请分册导入');
  const verifiedBlankPages=originalPdf.getPages().flatMap((page,index)=>{
    // Absence of extracted objects is not evidence of a blank scan. Only accept pages
    // with no drawing/text stream and no annotation appearance in the original PDF.
    if(page.node.Annots()?.size())return [];
    const contents=page.node.Contents();
    const streams=contents instanceof PDFArray?contents.asArray().map(ref=>originalPdf.context.lookup(ref)):[contents];
    const blank=streams.every(stream=>stream===undefined || (stream instanceof PDFStream &&
      (stream.getContentsSize()===0 || (!stream.dict.has(PDFName.of('Filter')) && !stream.getContentsString().trim()))));
    return blank?[index+1]:[];
  });
  const formulaEnriched=payload?.formulaEnriched??job?.formulaEnriched??(process.env.DOCLING_FORMULA_ENRICHMENT!=='false');
  if(typeof formulaEnriched!=='boolean')throw new Error('Invalid PDF formula enrichment setting');
  const formulaBackend=payload?.formulaBackend??job?.formulaBackend??process.env.DOCLING_FORMULA_BACKEND??'ai';
  if(typeof formulaBackend!=='string')throw new Error('Unknown PDF formula backend');
  if(!['ai','docling'].includes(formulaBackend))throw new Error('Unknown PDF formula backend');
  const localFormula=formulaEnriched&&formulaBackend==='docling';
  const formulaPreset=process.env.DOCLING_FORMULA_PRESET||'codeformulav2';
  const headers:HeadersInit=process.env.DOCLING_API_KEY?{'X-Api-Key':process.env.DOCLING_API_KEY}:{};
  const endpoint=base.replace(/\/$/,'');
  const references=await configuredFontReferences(),referencePolicy=process.env.PDF_FONT_REFERENCE_POLICY??referenceCidVersion;
  if(referencePolicy!==referenceCidVersion&&referencePolicy!==SOURCE_POST_AGL_POLICY)throw Error('Unknown configured source font reference policy');
  if(referencePolicy===SOURCE_POST_AGL_POLICY&&!references?.sourcePostAgl)throw Error('Source post/AGL v3 requires an explicit proven reference asset');
  const encoding=await prepareSourceFontInput(bytes,undefined,references,referencePolicy);
  const sourceFontObservations=encoding.observations?.length?{policy:'type1-missing-tounicode-observations-v1',
    sourceHash:document.hash,observations:encoding.observations}:undefined;
  if(encoding.proof&&(savedResult||legacyTaskId))encodingReview('legacy full-result input has no corrected-input identity');
  if(encoding.proof?.referenceDictionarySha256&&(!references||await storeDoclingResult(references)!==encoding.proof.referenceDictionarySha256))
    throw Error('Font reference CAS identity mismatch');
  const sourceEncodingReceiptHash=encoding.proof?await storeDoclingResult({kind:encoding.proof.version,proof:encoding.proof}):undefined;
  const parserPdf=encoding.proof?await PDFDocument.load(encoding.bytes,{updateMetadata:false}):originalPdf;
  const native=localFormula||process.env.DOCLING_NATIVE_TEXT_FASTPATH==='false'||savedResult||legacyTaskId||progress?null:await localPdfTextPages(encoding.bytes);
  // Keep the strict native gate: sparse/image-only bodies still need parsing.
  const nativeComplete=nativePdfTextIsComplete(native,originalPages,verifiedBlankPages);
  const scanBackend=payload?.scanBackend??job?.scanBackend??process.env.PDF_SCAN_TRANSCRIPTION_BACKEND??'docling';
  if(typeof scanBackend!=='string')throw new Error('Unknown PDF scan backend');
  if(!['ai','docling'].includes(scanBackend))throw new Error('Unknown PDF scan backend');
  const visual=!savedResult&&!legacyTaskId&&!progress&&!nativeComplete&&scanBackend==='ai';
  const prepare=async(start:number,end:number)=>{
    const copyIndices=Array.from({length:end-start+1},(_,i)=>start+i-1);
    const derived=await PDFDocument.create();
    // Stable metadata makes reconstruction and its checksum reproducible on retry.
    derived.setCreationDate(new Date(0));derived.setModificationDate(new Date(0));
    derived.setProducer('Study Kernel Docling derived-v1');derived.setCreator('Study Kernel');
    for(const page of await derived.copyPages(parserPdf,copyIndices))derived.addPage(page);
    const inputBytes=await derived.save();
    if((await PDFDocument.load(inputBytes,{updateMetadata:false})).getPageCount()!==copyIndices.length)
      throw new Error('Docling derived PDF page count mismatch');
    const value=new FormData();
    value.append('files',new Blob([new Uint8Array(inputBytes)],{type:'application/pdf'}),'pages.pdf');
    value.append('from_formats','pdf');value.append('to_formats','md');value.append('to_formats','json');
    value.append('do_ocr','true');value.append('do_table_structure','true');
    value.append('do_formula_enrichment',String(localFormula));value.append('code_formula_preset',formulaPreset);
    value.append('abort_on_error','true');
    value.append('page_range','1');value.append('page_range',String(copyIndices.length));
    return {form:value,inputHash:digest(inputBytes),copyIndices};
  };
  let currentProgress:DoclingProgress|undefined;
  let result=savedResult;
  // An old task ID has no range metadata: only resume that full response; never
  // submit a new whole-document request or reinterpret its pages as a batch.
  if(!result&&legacyTaskId)result=await requestDoclingResult(endpoint,headers,undefined,legacyTaskId,
    async taskId=>{if(job)await rememberDoclingTask(job.id,job.leaseToken,taskId);});
  const decoded:DecodedDocling=result?decodeDoclingResult(result,originalPages,{verifiedBlankPages,formulaEnriched:localFormula}):
    visual?{pages:await transcribePdfVisualPages(id,bytes,{expectedSourceHash:document.hash,
      pageNumbers:Array.from({length:originalPages},(_,index)=>index+1)}),totalPages:originalPages,
      warnings:['AI 视觉转写；数学、手写及图表请核对原 PDF'],formulaPageNumbers:[],nativeTables:[],
      visualLayout:{status:'unavailable' as const,regions:[],pageSizes:[],reason:'Visual transcription has no Docling layout'}}:
    nativeComplete?{pages:native!.map((text,index)=>({text,pageNumber:index+1,locator:`第 ${index+1} 页`})),
      totalPages:originalPages,warnings:formulaEnriched?[]:['公式增强未启用；正文可检索，公式须核对原 PDF'],formulaPageNumbers:[],nativeTables:[],
      visualLayout:{status:'unavailable' as const,regions:[],pageSizes:[],reason:'Native text path has no Docling layout'}}:
    await convertDoclingBatches({identity:{owner,documentId:id,sourceHash:document.hash,totalPages:originalPages,
      ...(sourceEncodingReceiptHash?{sourceEncodingReceiptHash}:{}),
      optionsHash:digest(JSON.stringify({transport:'docling-derived-v1',endpoint,parser:formulaEnriched?DOCLING_PARSER_VERSION:DOCLING_TEXT_PARSER_VERSION,
        doOcr:true,doTableStructure:true,localFormula,formulaBackend,formulaPreset,scanBackend,
        ...(sourceFontObservations?{sourceFontObservations}:{}),
        ...(sourceEncodingReceiptHash?{sourceEncodingReceiptHash,sourceEncodingVersion:encoding.proof!.version,textNormalization:'NFC'}:{} )}))},
      progress,verifiedBlankPages,formulaEnriched:localFormula,endpoint,headers,prepare,
      persist:async value=>{
        if(job)await rememberDoclingProgress(job.id,job.leaseToken,value);
        currentProgress=structuredClone(value);
      }});
  let pages=decoded.pages,warnings=decoded.warnings;
  if(sourceFontObservations)warnings=[...warnings,
    `第 ${[...new Set(sourceFontObservations.observations.map(value=>value.pageNumber))].join('、')} 页的部分 Type1 字体没有 ToUnicode；保留原始字体和输入，不补造字符映射。字符映射、实际字形使用和公式关系未验证，请以原 PDF 页图为准`];
  if(sourceEncodingReceiptHash&&!visual)warnings=[...warnings,
    encoding.proof?.patches.some(p=>p.reference?.sourceMapping.policy==='symbolic-simple-tt-post2-agl-contradiction-v1')?
    '源字体显式 Unicode 映射矛盾已按嵌入字形名、官方 AGL 及独立精确轮廓证明修正；其余公式、上下标及页面结构未验证':
    encoding.proof?.referenceDictionarySha256?'源字体缺失的 Unicode 映射已按精确字形及参考字符证明恢复；其余公式、上下标及页面结构未验证':
    '源字体 Unicode 映射冲突已按嵌入字形证明修正；其余公式、上下标及页面结构未验证'];
  const totalPages=decoded.totalPages;
  if(visual)warnings=[...warnings,...pages.filter(page=>page.text.includes('[无法可靠辨认')).map(page=>`第 ${page.pageNumber} 页含无法可靠辨认的片段，须核对原 PDF`)];
  if(formulaEnriched&&!visual&&(!localFormula||nativeComplete)){
    const enhanced=await enrichParsedPdfFormulae(id,bytes,pages,decoded.formulaPageNumbers);
    pages=enhanced.pages;
    warnings=[...warnings.filter(warning=>!warning.startsWith('公式增强未启用')), ...enhanced.warnings];
  }
  // Canonical Unicode composition only: raw parser responses and glyph evidence
  // remain unchanged; no formula, layout or whitespace inference is performed.
  if(sourceEncodingReceiptHash&&!visual)pages=pages.map(page=>({...page,text:page.text.normalize('NFC')}));
  const parserVersion=(formulaEnriched?DOCLING_PARSER_VERSION:DOCLING_TEXT_PARSER_VERSION)+
    (warnings.some(warning=>warning.includes(`[${DOCLING_NUL_PROJECTION_VERSION}]`))?`-${DOCLING_NUL_PROJECTION_VERSION}`:'')+
    (sourceFontObservations?'-type1-unmapped-observations-v1':'')+(sourceEncodingReceiptHash&&!visual?
    encoding.proof?.referenceDictionarySha256?`-${encoding.proof.version}`:'-source-encoding-v1':'')+(decoded.sourceMath?.length?'-source-math-v1':'');
  const current=await getDocument(owner,id);
  if(current.hash!==document.hash)throw new Error('Original PDF changed during conversion');
  if(digest(await readBlob(current.hash))!==document.hash)throw new Error('Original PDF checksum changed during conversion');
  if(result){
    const copyIndices=Array.from({length:originalPages},(_,index)=>index);
    const resultBlobSha256=await storeDoclingResult({identity:{owner,documentId:id,sourceHash:document.hash,totalPages:originalPages,
      inputHash:document.hash,copyIndices},result});
    decoded.visualLayout.regions=decoded.visualLayout.regions.map(region=>({...region,resultBlobSha256,
      derivedInputSha256:document.hash,copyIndices}));
    decoded.visualLayout.resultReferences=[{resultBlobSha256,derivedInputSha256:document.hash,copyIndices}];
    if(decoded.sourceMath)decoded.sourceMath=bindDoclingSourceMath(decoded.sourceMath,
      {resultBlobSha256,derivedInputSha256:document.hash,copyIndices,formulaEnriched:localFormula});
  }
  const pdfVisuals=await preparePdfVisualEvidence({owner,documentId:id,sourceHash:document.hash,pdfBytes:bytes,layout:decoded.visualLayout});
  const nativeTables=await prepareNativeTableCandidates({owner,documentId:id,sourceHash:document.hash,
    tables:decoded.nativeTables});
  const sourceMath=await prepareDoclingSourceMath({owner,documentId:id,sourceHash:document.hash,pages,structures:decoded.sourceMath});
  await kernel.ingestParsedDocument({id:document.id,ownerId:owner,courseId:document.course_id,name:document.name,
    hash:document.hash,mime:document.mime,origin:document.origin,originKey:document.origin_key,createdAt:document.created_at},pages,
    {parserVersion,expectedPages:totalPages,warnings,nativeTables,pdfVisuals,sourceMath,expectedCurrentVersion,
      ingestionLease:job?{id:job.id,token:job.leaseToken}:undefined,
      batchProvenance:currentProgress?{schema:currentProgress.schema,identity:currentProgress.identity,
        batchSize:currentProgress.batchSize,batches:currentProgress.batches,...(sourceFontObservations?{sourceFontObservations}:{})}:sourceEncodingReceiptHash&&!visual?
        {sourceEncoding:{receiptHash:sourceEncodingReceiptHash,parserInputHash:encoding.proof!.inputHash,version:encoding.proof!.version,textNormalization:'NFC'},
          ...(sourceFontObservations?{sourceFontObservations}:{})}:sourceFontObservations?{sourceFontObservations}:undefined,extractionMethod:visual?'ai-visual-page-transcription':nativeComplete?
      (formulaEnriched?'native-text-plus-ai-formula':'native-text'):formulaEnriched?`docling-plus-${formulaBackend}-formula`:'docling-text'});
  const chunks=pages.flatMap(page=>splitText(page.text).map(body=>({locator:page.locator,body})));
  // Search chunks are a rebuildable cache. The original blob and provenance remain available.
  await legacy.batch([
    legacy.prepare('DELETE FROM library_parse_pages WHERE document_id=? AND parser IN (?,?)').bind(id,'docling-v1',parserVersion),
    ...pages.map(page=>legacy.prepare('INSERT INTO library_parse_pages(document_id,parser,page,body) VALUES (?,?,?,?)')
      .bind(id,parserVersion,page.pageNumber-1,page.text)),
    legacy.prepare('DELETE FROM library_vectors WHERE chunk_id IN (SELECT id FROM library_chunks WHERE document_id=?)').bind(id),
    legacy.prepare('DELETE FROM library_chunks WHERE document_id=?').bind(id),
    ...chunks.map((chunk,index)=>legacy.prepare('INSERT INTO library_chunks(id,document_id,position,locator,body,hash) VALUES (?,?,?,?,?,?)')
      .bind(`${id}:${index}`,id,index,chunk.locator,chunk.body,digest(chunk.body))),
    legacy.prepare("UPDATE library_documents SET status='ready',error=? WHERE id=? AND deleted=0").bind(warnings.join('；')||null,id),
  ]);
}
