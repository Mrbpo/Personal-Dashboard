import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {observePdfNavigationText,coverPdfNavigationContainer,PDF_NAVIGATION_TEXT_LIMITS} from '../lib/kernel/pdf-navigation-text.ts';
import type {PdfInternalLink} from '../lib/kernel/pdf-internal-links.ts';
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const link:PdfInternalLink={sourcePageNumber:1,annotationIndex:0,annotationReference:'10 0 R',sourceRect:[20,30,40,50],
 coordinateSpace:'original-pdf-default-user-space',destinationName:'native-name',target:{status:'resolved-page',physicalPageNumber:3,view:'XYZ',parameters:[1,2,null]}};
function region(text='Name [7] describes the method.'){
 return {physicalPage:1,index:{pageSize:{width:600,height:800},nodes:[{reference:'#/texts/0',membership:'declared-provenance',
  textScope:'single-page',physicalPageNumbers:[1],raw:{label:'text',text},geometry:{status:'observed',bbox:{l:10,b:20,r:100,t:70,coord_origin:'BOTTOMLEFT'}}}]},
  image:{provenance:{rotation:0,pageSizePoints:{width:600,height:800},sourcePageCropBox:{x:0,y:0,width:600,height:800}}}} as any;
}
test('native rectangle/container and unique exact stored text produce only a source candidate without source mutation',()=>{
 const text='Name [7] describes the method.',body='😀 Intro\n\n'+text,r=region(text),before=JSON.stringify(r);
 const result=observePdfNavigationText(body,r,[link]),observation=result.observations[0];
 assert.equal(observation.status,'candidate');if(observation.status!=='candidate')throw Error('Missing candidate');
 assert.equal(observation.container.startUtf16,10);assert.equal(body.slice(observation.container.startUtf16,observation.container.endUtf16),text);
 assert.equal(observation.container.textSha256,hash(text));assert.equal(observation.wordLevelLinkPositionVerified,false);
 assert.equal(observation.semanticRelationsVerified,false);assert.equal(JSON.stringify(r),before);
});
test('ambiguous geometry and duplicate/missing body occurrences remain unknown; never pick the nearest box',()=>{
 const r=region(),text=r.index.nodes[0].raw.text;
 r.index.nodes.push({...structuredClone(r.index.nodes[0]),reference:'#/texts/1'});
 assert.equal((observePdfNavigationText(text,r,[link]).observations[0] as any).reason,'ambiguous-parser-containers');
 const normal=region();
 for(const body of ['other text',text+'\n'+text])assert.equal((observePdfNavigationText(body,normal,[link]).observations[0] as any).reason,'parser-text-not-unique-in-stored-page');
 const outside={...link,sourceRect:[101,30,120,50] as [number,number,number,number]};
 assert.equal((observePdfNavigationText(text,normal,[outside]).observations[0] as any).reason,'no-containing-parser-text');
});
test('unknown rotation/crop frames, wrong pages and missing rectangles do not gain a text binding',()=>{
 const r=region(),text=r.index.nodes[0].raw.text;r.image.provenance.rotation=90;
 assert.equal((observePdfNavigationText(text,r,[link]).observations[0] as any).reason,'incompatible-or-unknown-original-frame');
 const cropped=region();cropped.image.provenance.sourcePageCropBox.x=1;
 assert.equal(observePdfNavigationText(text,cropped,[link]).compatibleOriginalFrame,false);
 assert.equal((observePdfNavigationText(text,region(),[{...link,sourcePageNumber:2}]).observations[0] as any).reason,'different-original-page');
 assert.equal((observePdfNavigationText(text,region(),[{...link,sourceRect:null}]).observations[0] as any).reason,'source-rectangle-unknown');
 const invalid=region();invalid.index.nodes[0].geometry.bbox.l=-1;
 assert.equal((observePdfNavigationText(text,invalid,[link]).observations[0] as any).status,'unknown');
});
test('split quote ranges may cover a container collectively, but no gap or missing part is filled',()=>{
 const container={startUtf16:10,endUtf16:30};
 assert.deepEqual(coverPdfNavigationContainer(container,[{startUtf16:10,endUtf16:20},{startUtf16:20,endUtf16:30}]),[0,1]);
 assert.equal(coverPdfNavigationContainer(container,[{startUtf16:10,endUtf16:20}]),null);
 assert.equal(coverPdfNavigationContainer(container,[{startUtf16:10,endUtf16:20},{startUtf16:21,endUtf16:30}]),null);
 assert.deepEqual(coverPdfNavigationContainer(container,[{startUtf16:0,endUtf16:5},{startUtf16:8,endUtf16:35}]),[1]);
 assert.throws(()=>coverPdfNavigationContainer(container,[{startUtf16:-1,endUtf16:40}]),/Invalid bounded/);
});
test('bounded navigation-container and selected-range scans explicitly retain omissions',()=>{
 const r=region(),text=r.index.nodes[0].raw.text,links=Array.from({length:129},(_,annotationIndex)=>({...link,annotationIndex}));
 const result=observePdfNavigationText(text,r,links);assert.equal(result.observations.length,128);assert.equal(result.omittedLinks,1);
 assert.throws(()=>observePdfNavigationText('x'.repeat(PDF_NAVIGATION_TEXT_LIMITS.bodyBytes+1),r,[link]),/exceeds limit/);
 assert.throws(()=>coverPdfNavigationContainer({startUtf16:0,endUtf16:1},Array.from({length:65},()=>({startUtf16:0,endUtf16:1}))),/Invalid bounded/);
});
