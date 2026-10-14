import {createHash} from 'node:crypto';
import {PDFDocument} from 'pdf-lib';

export type SourceGlyph={symbol:string;font:string;bold:boolean|null;bbox:[number,number,number,number];subscript:string|null};
export type SourceMathRegion={number:string;bbox:[number,number,number,number];glyphs:SourceGlyph[];
 // This proof covers only the vector bases and subscripts being changed.
 // It does not certify the mathematics of fractions or stacked limits.
 vectorOrderVerified?:boolean};
export type PdfSourceMathEvidence={sourceSha256:string;pageNumber:number;pageCount:number;
 pageSize:[number,number];extractor:string;regions:SourceMathRegion[]};
const hash=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
const inside=(a:number[],b:number[])=>a[0]>=b[0]&&a[1]>=b[1]&&a[2]<=b[2]&&a[3]<=b[3];
const boxValid=(box:number[],size:number[])=>box.length===4&&box.every(Number.isFinite)&&
 box[0]>=0&&box[1]>=0&&box[2]>box[0]&&box[3]>box[1]&&box[2]<=size[0]&&box[3]<=size[1];

/** Read-only audit. No cache writes, mathematical edits, model calls or publish. */
export async function auditPdfSourceFidelity(original:Uint8Array,evidence:PdfSourceMathEvidence,text:string){
 const sourceSha256=hash(original);
 const pdf=await PDFDocument.load(original,{updateMetadata:false});
 if(sourceSha256!==evidence.sourceSha256||pdf.getPageCount()!==evidence.pageCount||
  !Number.isInteger(evidence.pageNumber)||evidence.pageNumber<1||evidence.pageNumber>evidence.pageCount)
  throw new Error('Source hash or original physical page identity mismatch');
 const page=pdf.getPage(evidence.pageNumber-1),size=[page.getWidth(),page.getHeight()];
 if(evidence.pageSize.length!==2||size.some((value,index)=>Math.abs(value-evidence.pageSize[index])>.01)||
  !evidence.extractor||!evidence.regions.length||new Set(evidence.regions.map(region=>region.number)).size!==evidence.regions.length||
  evidence.regions.some(region=>! /^[\p{L}\p{N}.\-]{1,32}$/u.test(region.number)||!boxValid(region.bbox,size)||region.glyphs.some(glyph=>
   !/^\p{L}$/u.test(glyph.symbol)||!glyph.font||![true,false,null].includes(glyph.bold)||!boxValid(glyph.bbox,size)||!inside(glyph.bbox,region.bbox)||
   (glyph.bold===true&&evidence.regions.some(other=>other!==region&&inside(glyph.bbox,other.bbox))))))
  throw new Error('Invalid or ambiguous source equation geometry');
 const math:Array<{start:number;end:number;body:string;display:boolean}>=[];
 let open:{start:number;bodyStart:number;display:boolean}|undefined;const boundaryErrors:string[]=[];
 for(const match of text.matchAll(/\\[()[\]]/g)){
  const token=match[0],offset=match.index!;
  if(token==='\\('||token==='\\['){if(open)boundaryErrors.push('nested-math-boundary');open={start:offset,bodyStart:offset+2,display:token==='\\['};}
  else if(!open||(token==='\\]')!==open.display){boundaryErrors.push('unmatched-math-boundary');open=undefined;}
  else{math.push({start:open.start,end:offset+2,body:text.slice(open.bodyStart,offset),display:open.display});open=undefined;}
 }
 if(open)boundaryErrors.push('unclosed-math-boundary');
 const outsideMath=[...text.matchAll(/\\(?:tag\{[^}]*\}|hfill|[{}])/g)].filter(match=>
  !math.some(environment=>match.index!>=environment.start&&match.index!<environment.end))
  .map(match=>({token:match[0],offset:match.index!}));
 const regions=evidence.regions.map(region=>{
  const numbered=math.filter(environment=>{
   const tagged=[...environment.body.matchAll(/\\tag\{([^}]+)\}/g)].map(match=>match[1]);
   const external=text.slice(environment.end).match(/^\s*\\(?:hfill\s*\(([^)]+)\)|tag\{([^}]+)\})/);
   return tagged.includes(region.number)||external?.[1]===region.number||external?.[2]===region.number;
  });
  const reasons:string[]=[];
  if(numbered.length!==1)reasons.push('equation-number-not-unique');
  if(!region.vectorOrderVerified)reasons.push('source-vector-reading-order-unverified');
  const environment=numbered.length===1?numbered[0]:undefined;

  const bold=region.glyphs.filter(glyph=>glyph.bold===true),unknown=region.glyphs.filter(glyph=>glyph.bold===null);
  if(unknown.length)reasons.push('unknown-source-font-style');
  const boldCommands=environment?[...environment.body.matchAll(/\\(?:mathbf|boldsymbol)\{/g)].length:0;
  const mappings=environment?vectorMappings(region,environment.body):[];
  const vectorMappingUnique=Boolean(region.vectorOrderVerified&&mappings.length===bold.length&&mappings.every(mapping=>mapping.unique));
  if(bold.length&&!vectorMappingUnique)reasons.push('vector-region-token-correspondence-unknown');
  if(bold.length>boldCommands)reasons.push('possible-vector-font-loss');
  if(environment&&!environment.display)reasons.push('numbered-equation-is-inline');
  return {number:region.number,sourceBoldGlyphs:bold.map(glyph=>({symbol:glyph.symbol,subscript:glyph.subscript,font:glyph.font,bbox:glyph.bbox})),
   matchingEnvironments:numbered.length,environment:environment?{start:environment.start,end:environment.end,display:environment.display}:null,
   transcribedBoldCommands:boldCommands,vectorMappingUnique,mappings,reasons,repairAuthorized:false};
 });
 return {mode:'audit-only' as const,sourceSha256,pageNumber:evidence.pageNumber,evidenceSha256:hash(JSON.stringify(evidence)),
  transcriptionSha256:hash(text),boundaryErrors,outsideMath,regions,requiresReview:true,
  derivedStaging:null,reason:'Read-only region mapping; raw recognition caches are unchanged and no transformation has been authorized'};
}

const greek:Record<string,string>={α:'alpha',β:'beta',γ:'gamma',δ:'delta',ε:'epsilon',ζ:'zeta',η:'eta',θ:'theta',ι:'iota',κ:'kappa',λ:'lambda',μ:'mu',ν:'nu',ξ:'xi',π:'pi',ρ:'rho',σ:'sigma',τ:'tau',υ:'upsilon',φ:'phi',χ:'chi',ψ:'psi',ω:'omega',Γ:'Gamma',Δ:'Delta',Θ:'Theta',Λ:'Lambda',Ξ:'Xi',Π:'Pi',Σ:'Sigma',Υ:'Upsilon',Φ:'Phi',Ψ:'Psi',Ω:'Omega'};
function vectorMappings(region:SourceMathRegion,body:string){
 const bold=region.glyphs.filter(glyph=>glyph.bold===true);
 return bold.map((glyph,index)=>{
  const base=greek[glyph.symbol]?'\\'+greek[glyph.symbol]:glyph.symbol;
  const escaped=base.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const pattern=new RegExp('(?<![A-Za-z])(?:\\\\(?:mathbf|boldsymbol)\\{)?'+escaped+'(?![A-Za-z])\\}?(?:_\\{?([A-Za-z0-9]+)\\}?)?','g');
  const sourceOfBase=region.glyphs.filter(item=>item.symbol===glyph.symbol);
  const literalRanges=[...body.matchAll(/\\(?:text|tag|operatorname)\{[^}]*\}/g)];
  const matches=[...body.matchAll(pattern)].filter(match=>!literalRanges.some(literal=>
   match.index!>=literal.index!&&match.index!<literal.index!+literal[0].length));
  const expected=sourceOfBase.map(item=>item.subscript),observed=matches.map(match=>match[1]??null);
  const orderMatches=JSON.stringify(expected)===JSON.stringify(observed);
  const position=sourceOfBase.indexOf(glyph),match=matches[position];
  const alreadyBold=Boolean(match&&/^\\(?:mathbf|boldsymbol)\{/.test(match[0]));
  const baseOffset=match?match.index!+(alreadyBold?match[0].indexOf('{')+1:0):null;
  return {symbol:glyph.symbol,subscript:glyph.subscript,bbox:glyph.bbox,index,base,
   alreadyBold,
   unique:orderMatches&&sourceOfBase.every(item=>item.bold!==null)&&Boolean(match)&&Boolean(greek[glyph.symbol]||/^[A-Za-z]$/.test(glyph.symbol)),
   sourceTokens:expected,transcribedTokens:observed,offset:baseOffset};
 });
}

export async function stagePdfSourceFidelity(original:Uint8Array,evidence:PdfSourceMathEvidence,rawText:string){
 const audit=await auditPdfSourceFidelity(original,evidence,rawText);
 if(audit.boundaryErrors.length||audit.regions.some(region=>region.matchingEnvironments!==1||
  region.reasons.includes('unknown-source-font-style')||(region.sourceBoldGlyphs.length&&!region.vectorMappingUnique)))
  throw new Error('Source region or vector correspondence needs review; no derived staging');
 const operations:Array<{start:number;end:number;before:string;after:string;kind:string;region?:string;bbox?:number[]}>=[];
 const replace=(start:number,end:number,after:string,kind:string,region?:string,bbox?:number[])=>
  operations.push({start,end,before:rawText.slice(start,end),after,kind,...(region?{region}:{}),...(bbox?{bbox}:{})});
 for(const region of audit.regions){
  const environment=region.environment!;
  for(const mapping of region.mappings){
   if(mapping.alreadyBold)continue;
   const start=environment.start+2+mapping.offset!;
   if(rawText.slice(start,start+mapping.base.length)!==mapping.base)throw new Error('Vector source offset changed');
   replace(start,start+mapping.base.length,`\\${greek[mapping.symbol]?'boldsymbol':'mathbf'}{${mapping.base}}`,'source-font-restoration',region.number,mapping.bbox);
  }
  // Only an immediately adjacent, identical printed number can be moved.
  const external=rawText.slice(environment.end).match(/^\s*\\(?:tag\{([^}]+)\}|hfill\s*\(([^)]+)\))/);
  if(external&&(external[1]??external[2])===region.number){
   replace(environment.end-2,environment.end+external[0].length,`\\tag{${region.number}}\\]`,'adjacent-number-to-display',region.number);
   if(!environment.display)replace(environment.start,environment.start+2,'\\[','numbered-display-open',region.number);
  }else if(!environment.display){
   replace(environment.start,environment.start+2,'\\[','numbered-display-open',region.number);
   replace(environment.end-2,environment.end,'\\]','numbered-display-close',region.number);
  }
 }
 // The braces must enclose exactly one complete existing inline environment.
 // Moving the delimiters preserves every character of its mathematical body.
 for(const match of rawText.matchAll(/\\\{\s*\\\(([\s\S]*?)\\\)\s*\\\}/g)){
  if(/\\[()[\]]/.test(match[1]))throw new Error('Ambiguous collection math boundary');
  replace(match.index!,match.index!+match[0].length,`\\(\\{${match[1]}\\}\\)`,'complete-collection-boundary');
 }
 operations.sort((a,b)=>a.start-b.start);
 if(operations.some((operation,index)=>index>0&&operation.start<operations[index-1].end))
  throw new Error('Overlapping source transformations; no derived staging');
 let text=rawText;
 for(const operation of [...operations].reverse())text=text.slice(0,operation.start)+operation.after+text.slice(operation.end);
 const after=await auditPdfSourceFidelity(original,evidence,text);
 return {kind:'source-font-derived-staging' as const,transformVersion:'pdf-source-fidelity-derived-v1',
  sourceSha256:audit.sourceSha256,pageNumber:evidence.pageNumber,sourceEvidenceSha256:audit.evidenceSha256,
  rawRecognitionSha256:audit.transcriptionSha256,derivedTextSha256:hash(text),operations,text,
  requiresManualReview:true,notForApplyPageRepair:true,remainingBoundaryIssues:after.outsideMath,
  warning:'Only source-proven font style and structural math boundaries changed; other mathematics is not certified'};
}
