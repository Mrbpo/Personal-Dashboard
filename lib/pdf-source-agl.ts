import {createHash} from 'node:crypto';
import type {PdfFontReferenceDictionary} from './pdf-source-fidelity.ts';

export const SOURCE_POST_AGL_POLICY='source-font-reference-v3' as const;
export const OFFICIAL_AGL_SOURCE='https://raw.githubusercontent.com/adobe-type-tools/agl-aglfn/4036a9ca80a62f64f9de4f7321a9a045ad0ecfd6/glyphlist.txt';
export const OFFICIAL_AGL_SHA256='a3b2f61ced9f3644cc0d4ecde5c59df34ca286c689d9484a43a710a81c466789';
const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
type AglWitness={hex:string;line:number;literal:string};
let official:Map<string,AglWitness>|undefined;
const publicScalar=(cp:number)=>Number.isInteger(cp)&&cp>0x1f&&cp<=0x10ffff&&!(cp>=0x7f&&cp<=0x9f)&&
 !(cp>=0xd800&&cp<=0xdfff)&&!(cp>=0xe000&&cp<=0xf8ff)&&!(cp>=0xf0000&&cp<=0xffffd)&&!(cp>=0x100000&&cp<=0x10fffd)&&cp!==0xfffd;
/** Unicode comes only from the fixed official glyph-name list. Symbol/Mac raw
 * cmap slots are used solely for source-byte→GID, never as Unicode witnesses. */
export function validateSourcePostAgl(d:PdfFontReferenceDictionary){
 const a=d.sourcePostAgl;if(!a)return undefined;
 if(a.version!=='embedded-post2-agl-exact-outline-v1'||typeof a.glyphList!=='string'||Buffer.byteLength(a.glyphList)>100000||
  hash(a.glyphList)!==OFFICIAL_AGL_SHA256||Object.keys(a).some(k=>!['version','glyphList','outlines'].includes(k))||
  !Array.isArray(a.outlines)||!a.outlines.length||a.outlines.length>8192)throw Error('Invalid pinned source post/AGL evidence');
 const seen=new Set<string>();
 for(const r of a.outlines){if(!Array.isArray(r)||r.length!==4||typeof r[0]!=='string'||!/^[a-f0-9]{64}$/.test(r[0])||
  !Number.isInteger(r[1])||r[1]<1||r[1]>65535||!Number.isInteger(r[2])||r[2]<0||r[2]>=d.fonts.length||d.fonts[r[2]].unitsPerEm!==r[1]||
  !Number.isInteger(r[3])||r[3]<1||r[3]>65535||seen.has(JSON.stringify(r)))throw Error('Invalid independent outline witness');seen.add(JSON.stringify(r));}
 if(!official){official=new Map();const names=new Set<string>();
  for(const [i,line]of a.glyphList.split('\n').entries()){if(!line||line.startsWith('#'))continue;
   const [name,values,...extra]=line.split(';');if(extra.length||!name||!values||names.has(name))throw Error('Ambiguous official glyph name');names.add(name);
   if(!/^[0-9A-F]{4,6}$/.test(values))continue;const cp=parseInt(values,16);if(!publicScalar(cp))continue;
   official.set(name,{hex:Buffer.from(String.fromCodePoint(cp),'utf16le').swap16().toString('hex').toUpperCase(),line:i+1,literal:line});
  }
 }
}
type NativeGlyph={id:number;name?:string;path:{commands:Array<{command:string;args:number[]}>}};
export type SourcePostFont={numGlyphs:number;unitsPerEm:number;post?:{version:number};getGlyph:(gid:number)=>NativeGlyph};
const pathHash=(font:SourcePostFont,glyph:NativeGlyph)=>{
 const commands=glyph.path.commands.map(c=>({command:c.command,args:[...c.args]}));
 if(!commands.length||commands.length>10000||commands.some(c=>c.args.some(n=>!Number.isFinite(n))))return undefined;
 return hash(JSON.stringify({unitsPerEm:font.unitsPerEm,commands}));
};
/** Candidate identity only; this does not certify page rendering or mathematics. */
export function sourcePostAglCandidate(font:SourcePostFont,gid:number,sourceFontSha256:string,d:PdfFontReferenceDictionary){
 validateSourcePostAgl(d);const agl=official;if(!d.sourcePostAgl||!agl||font.post?.version!==2||!Number.isInteger(font.numGlyphs)||font.numGlyphs<2||font.numGlyphs>4096||
  !Number.isInteger(gid)||gid<1||gid>=font.numGlyphs||!Number.isInteger(font.unitsPerEm)||font.unitsPerEm<1||font.unitsPerEm>65535||!/^[a-f0-9]{64}$/.test(sourceFontSha256))return;
 const glyph=font.getGlyph(gid),witness=typeof glyph.name==='string'?agl.get(glyph.name):undefined;
 if(!witness)return;const path=pathHash(font,glyph);if(!path)return;
 const outlines=d.sourcePostAgl!.outlines.map((r,index)=>({r,index})).filter(({r})=>r[0]===path);
 if(!outlines.length||outlines.some(({r})=>r[1]!==font.unitsPerEm||d.fonts[r[2]].sha256===sourceFontSha256))return;
 if(d.entries.some(e=>e[0]===path&&e[1]!==witness.hex))return;
 // A second source glyph with the same exact outline must not give a different
 // official meaning (or an undecodable name). No fuzzy outline/font aliases.
 for(let i=1;i<font.numGlyphs;i++){if(i===gid)continue;const other=font.getGlyph(i);
  if(pathHash(font,other)===path&&agl.get(other.name??'')?.hex!==witness.hex)return;}
 return {glyphName:glyph.name!,pathSha256:path,utf16Hex:witness.hex,
  agl:{source:OFFICIAL_AGL_SOURCE,sha256:OFFICIAL_AGL_SHA256,line:witness.line,literal:witness.literal},
  outlineWitnesses:outlines.map(({r,index})=>({index,fontIndex:r[2],glyphId:r[3]}))};
}

/** Offset-preserving lexical view: PostScript comments and literal strings
 * cannot declare active CMap operators. Original stream bytes stay untouched. */
export function sourceCmapLexicalView(text:string){
 const view=text.split('');let depth=0,escaped=false,comment=false;
 for(let i=0;i<text.length;i++){const c=text[i];
  if(comment){if(c==='\r'||c==='\n')comment=false;else view[i]=' ';continue;}
  if(depth){if(c!=='\r'&&c!=='\n')view[i]=' ';
   if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='(')depth++;else if(c===')')depth--;
   continue;}
  if(c==='%'){comment=true;view[i]=' ';}else if(c==='('){depth=1;view[i]=' ';}
 }
 if(depth)throw Error('Unterminated source CMap literal string');return view.join('');
}

/** Replace only an explicit bfchar or singleton bfrange destination. Other
 * ranges/arrays remain unsupported; final caller validates every mapping. */
export function replaceSingleCmapDestination(text:string,code:number,beforeHex:string,afterHex:string){
 const targets:Array<{start:number;end:number}>=[],view=sourceCmapLexicalView(text);
 for(const kind of ['bfchar','bfrange'])for(const block of view.matchAll(new RegExp(`\\d+\\s+begin${kind}\\b([\\s\\S]*?)\\bend${kind}`,'g'))){
  const bodyStart=block.index!+block[0].indexOf('begin'+kind)+('begin'+kind).length,
   pattern=kind==='bfchar'?/<([\da-f]{2})>\s*<([\da-f\s]+)>/gi:/<([\da-f]{2})>\s*<([\da-f]{2})>\s*<([\da-f\s]+)>/gi;
  for(const m of block[1].matchAll(pattern)){if(parseInt(m[1],16)!==code||(kind==='bfrange'&&parseInt(m[2],16)!==code))continue;
   if(m[kind==='bfchar'?2:3].replace(/\s/g,'').toUpperCase()!==beforeHex)return undefined;
   const offset=bodyStart+m.index!;targets.push({start:offset+m[0].lastIndexOf('<'),end:offset+m[0].length});}
 }
 if(targets.length!==1)return undefined;const t=targets[0];return text.slice(0,t.start)+`<${afterHex}>`+text.slice(t.end);
}
