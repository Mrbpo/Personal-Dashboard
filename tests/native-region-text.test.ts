import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readdir,unlink,rmdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {NATIVE_REGION_TEXT_VERSION,validateNativeRegionBundle,projectNativeRegionText,prepareNativeRegionWindows,
 readNativeRegionObservation,nativeRegionFingerprint,nativeRegionHash,nativeRegionBaseline,type NativeRegionBundle} from '../lib/kernel/native-region-text.ts';
import {prepareDocumentAnswer,resolveDocumentAnswerSelections,validateGroundedDocumentAnswer,buildSelectedDocumentAnswerRequest,
 DOCUMENT_ANSWER_VISUAL_UNIT_POLICY} from '../lib/kernel/document-answer.ts';
import {prepareDocumentCitationAudit,buildDocumentCitationAuditRequest} from '../lib/kernel/document-citation-audit.ts';

const source={owner:'owner',documentId:'paper',sourceHash:'a'.repeat(64),pageCount:1},text='.650 / .647 / .654';
const bundle=():NativeRegionBundle=>({policy:'native-pdf-region-observations-v1',source:{...source},producer:{engine:'pdfplumber',packages:{pdfplumber:'0.11.9','pdfminer.six':'20251230'},
 options:{layout:true,x_tolerance:2,y_tolerance:2},scriptSha256:'b'.repeat(64),boundsExportSha256:'c'.repeat(64),boundsAuthority:'parser-declared-untrusted'},
 pages:[{physicalPage:1,width:100,height:100,chars:[...text.replaceAll(' ','')].map((t,i)=>({index:i,text:t,bbox:[i+1,1,i+2,5],font:'F1'})),
 regions:[{id:'table-0',bbox:[0,0,50,10],text,charIndices:Array.from({length:text.replaceAll(' ','').length},(_,i)=>i),boundsReference:'#/tables/0'}]}]});
const oldDir=process.env.LIBRARY_DIR,dir=await mkdtemp(join(tmpdir(),'native-region-test-'));process.env.LIBRARY_DIR=dir;
after(async()=>{if(oldDir===undefined)delete process.env.LIBRARY_DIR;else process.env.LIBRARY_DIR=oldDir;for(const f of await readdir(dir))await unlink(join(dir,f));await rmdir(dir);});
async function staged(b=bundle()){
 const raw=JSON.stringify(b),observationSha256=nativeRegionHash(raw);await writeFile(join(dir,observationSha256),raw);
 const projection=projectNativeRegionText(b,[{pageNumber:1,locator:'第 1 页',text:'Previous native body.'}],observationSha256),rawManifest=JSON.stringify(projection.manifest),manifestSha256=nativeRegionHash(rawManifest);
 await writeFile(join(dir,manifestSha256),rawManifest);
 const body=projection.pages[0].text,input={...source,currentVersionId:'current',sourceVersionId:'source-version',evidenceId:'evidence',physicalPage:1,
  parserVersion:NATIVE_REGION_TEXT_VERSION,body,bodySha256:nativeRegionHash(body),progress:{nativeRegionText:{policy:NATIVE_REGION_TEXT_VERSION,manifestSha256,observationSha256}}};
 return {input,b,projection,manifestSha256,observationSha256};
}
test('native projection preserves previous text and exact observed character sequence',()=>{
 const b=bundle(),before=JSON.stringify(b),r=projectNativeRegionText(b,[{pageNumber:1,locator:'page1',text:'Old text'}],'d'.repeat(64));
 assert.equal(r.pages[0].text,'Old text\n\n'+text);assert.equal(JSON.stringify(b),before);
 assert.equal(r.manifest.pages[0].windows[0].startUtf16,'Old text\n\n'.length);
 assert.equal(r.manifest.pages[0].windows[0].quoteSha256,nativeRegionHash(text));
});
test('foreign source, omitted decimal, clipped glyph and missing original character cannot become observations',()=>{
 assert.throws(()=>validateNativeRegionBundle(bundle(),{...source,owner:'foreign'}));
 const missing=bundle();missing.pages[0].regions[0].text=text.slice(1);assert.throws(()=>validateNativeRegionBundle(missing,source));
 const clipped=bundle();clipped.pages[0].regions[0].bbox[0]=1.5;assert.throws(()=>validateNativeRegionBundle(clipped,source));
 const absent=bundle();absent.pages[0].regions[0].charIndices.shift();assert.throws(()=>validateNativeRegionBundle(absent,source));
});
test('registered CAS produces source-bound immutable windows and a separately readable character observation',async()=>{
 const {input}=await staged(),hint=await prepareNativeRegionWindows(input),observation=await readNativeRegionObservation(input);
 assert.equal(hint?.windows.length,1);assert.equal(observation?.page.chars.length,text.replaceAll(' ','').length);
 assert.equal(observation?.semanticRelationsVerified,false);assert.equal(hint?.windows[0].quoteSha256,nativeRegionHash(text));
 assert.throws(()=>{hint!.windows[0].references[0].reference='changed';});
 assert.notEqual(nativeRegionFingerprint(input.progress)?.manifestSha256,undefined);
 await assert.rejects(()=>prepareNativeRegionWindows({...input,body:input.body+'.'}));
 await assert.rejects(()=>prepareNativeRegionWindows({...input,documentId:'foreign'}));
});
test('actual answer preparation offers the complete region, retains other evidence, rejects clones and stale bodies',async()=>{
 const {input}=await staged(),hint=(await prepareNativeRegionWindows(input))!;
 const anchor={id:'pg:current:1',document_id:source.documentId,course_id:'',name:'Study',origin:'fixture',origin_key:'x',source_hash:source.sourceHash,
  source_version_id:'source-version',body:input.body,locator:'第 1 页',page_number:1,evidence_id:'evidence',parser_version:NATIVE_REGION_TEXT_VERSION,score:1,evidence_body:'full-page' as const};
 const context={anchors:[anchor,{...anchor,id:'pg:other:1',document_id:'other',evidence_id:'other-evidence',body:'Other source still present.'}],images:[],parents:[],sourceContentIsUntrusted:true as const,
  textQuotePolicy:'stored-page-v1' as const,nativeRegionWindows:[hint]};
 const p=prepareDocumentAnswer('Compare the scores',context),q=p.quoteUnits.find(q=>q.contextWindow?.policy==='native-region-text-windows-v1');
 assert.equal(q?.text,text);assert.equal(p.supports.filter(s=>s.kind==='text').length,2);
 assert.throws(()=>prepareDocumentAnswer('Compare the scores',{...context,nativeRegionWindows:[JSON.parse(JSON.stringify(hint))]}));
 assert.throws(()=>prepareDocumentAnswer('Compare the scores',{...context,anchors:[{...anchor,body:input.body+' changed'}]}));
});
test('a modified native CAS blob cannot reuse the source-registered observation hash',async()=>{
 const {input,observationSha256}=await staged();await writeFile(join(dir,observationSha256),'{}');
 await assert.rejects(()=>prepareNativeRegionWindows(input));
});

test('a whole source-bound region longer than the legacy quote limit resolves without relaxing arbitrary literal citations',async()=>{
 const b=bundle(),long=(text+'\n').repeat(100),glyphs=[...long.replace(/\s/gu,'')];
 b.pages[0].chars=glyphs.map((t,i)=>({index:i,text:t,bbox:[i*.01+1,1,i*.01+1.005,5],font:'F1'}));
 b.pages[0].regions[0].text=long;b.pages[0].regions[0].charIndices=glyphs.map((_,i)=>i);
 const {input}=await staged(b),hint=(await prepareNativeRegionWindows(input))!,anchor={id:'pg:current:1',document_id:source.documentId,course_id:'',name:'Study',origin:'fixture',origin_key:'x',
  source_hash:source.sourceHash,source_version_id:'source-version',body:input.body,locator:'第 1 页',page_number:1,evidence_id:'evidence',parser_version:NATIVE_REGION_TEXT_VERSION,score:1,evidence_body:'full-page' as const},
  prepared=prepareDocumentAnswer('What are the scores?',{anchors:[anchor],images:[],parents:[],sourceContentIsUntrusted:true,nativeRegionWindows:[hint]}),
  quote=prepared.quoteUnits.find(q=>q.contextWindow?.policy==='native-region-text-windows-v1')!;
 assert.ok(quote.text.length>1200);assert.equal(quote.text,long);
 const resolved=resolveDocumentAnswerSelections({status:'answered',message:'',claims:[{text:'Transport fixture only.',citations:[{id:quote.id}]}]},prepared.supports);
 assert.equal(resolved.answer.claims[0].citations[0].quote,long);
 assert.throws(()=>validateGroundedDocumentAnswer({status:'answered',message:'',claims:[{text:'Literal fixture.',citations:[{id:'e0',quote:long}]}]},[{id:'e0',kind:'text',text:input.body}]),/ungrounded/);
});

function captionBundle(){
 const b=bundle(),offset=b.pages[0].chars.length,caption='Table1:SLC';
 b.pages[0].chars.push(...[...caption].map((text,i)=>({index:offset+i,text,bbox:[i+1,12,i+2,16] as [number,number,number,number],font:'F1'})));
 return b;
}
function includeCaption(b:NativeRegionBundle){
 const r=b.pages[0].regions[0],glyphs=b.pages[0].chars.filter(c=>c.bbox[1]===12);
 r.tableBBox=[...r.bbox];r.bbox=[0,0,50,16];r.text+='\nTable1:SLC';r.charIndices.push(...glyphs.map(c=>c.index));
 r.captions=[{reference:'#/texts/0',declaredBBox:[0,11,50,20],bbox:[1,12,11,16],charIndices:glyphs.map(c=>c.index),producerText:'Table 1: SLC'}];
 b.producer.options.expand_ligatures=false;return b;
}
test('declared captions retain their original glyphs in one bound quotation without certifying semantic relations',async()=>{
 const b=includeCaption(captionBundle());assert.equal(validateNativeRegionBundle(b,source),b);
 const {input}=await staged(b),hint=(await prepareNativeRegionWindows(input))!,observation=(await readNativeRegionObservation(input))!;
 assert.equal(hint.windows[0].references.length,2);assert.equal(hint.windows[0].references[1].reference,'native-caption:#/texts/0');
 assert.equal(observation.page.regions[0].text,text+'\nTable1:SLC');assert.equal(observation.semanticRelationsVerified,false);
 assert.throws(()=>hint.windows[0].captionReferences!.push('#/texts/other'));
 const bad=structuredClone(b);bad.pages[0].regions[0].captions![0].charIndices.shift();assert.throws(()=>validateNativeRegionBundle(bad,source));
});
test('caption supersession recovers only the unchanged baseline and refuses loss of any previous source glyph',async()=>{
 const old=captionBundle(),{input}=await staged(old),previous=(await readNativeRegionObservation(input))!,next=includeCaption(structuredClone(old)),
  baseline=nativeRegionBaseline(previous,next,input.body);
 assert.equal(baseline,'Previous native body.');
 const projection=projectNativeRegionText(next,[{pageNumber:1,locator:'第 1 页',text:baseline}],'f'.repeat(64));
 assert.equal(projection.pages[0].text,'Previous native body.\n\n'+text+'\nTable1:SLC');
 const changed=structuredClone(next);changed.pages[0].chars[0].text='x';assert.throws(()=>nativeRegionBaseline(previous,changed,input.body));
 const lost=structuredClone(next);lost.pages[0].regions[0].charIndices.shift();assert.throws(()=>nativeRegionBaseline(previous,lost,input.body));
 assert.throws(()=>nativeRegionBaseline(previous,next,input.body+' changed'));
});

async function nativeVisualContext(){
 const {input}=await staged(),hint=(await prepareNativeRegionWindows(input))!,
  png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64'),hash=nativeRegionHash(png),
  anchor={id:'pg:current:1',document_id:source.documentId,course_id:'',name:'Study',origin:'fixture',origin_key:'x',source_hash:source.sourceHash,
   source_version_id:'source-version',body:input.body,locator:'第 1 页',page_number:1,evidence_id:'evidence',parser_version:NATIVE_REGION_TEXT_VERSION,score:1,evidence_body:'full-page' as const},
  image={kind:'pdf-page' as 'pdf-page'|'pdf-region',attachmentId:'original-page',anchorEvidenceId:'evidence',assetId:hash,sha256:hash,byteLength:png.length,width:1,height:1,
   mime:'image/png' as const,bytes:png,physicalPage:1,rawPdfSha256:source.sourceHash,manifestSha256:'f'.repeat(64),
   provenance:{rawPdfSha256:source.sourceHash,pageRenderSha256:hash,pageSizePoints:{width:100,height:100},rotation:0,
    rendererPolicy:'component-fixture-only',sourcePageCropBox:{x:0,y:0,width:100,height:100}},
   source:{documentId:source.documentId,currentVersionId:'current',sourceVersionId:'source-version',sourceHash:source.sourceHash}};
 return {context:{anchors:[anchor,{...anchor,id:'pg:other:1',document_id:'other',evidence_id:'outside',body:'Other source retained.'}],images:[image],parents:[],
  sourceContentIsUntrusted:true as const,textQuotePolicy:'stored-page-v1' as const,nativeRegionWindows:[hint]},png};
}

test('native complex PDF quotation and its original page remain one source through generation and local citation checking',async()=>{
 const {context,png}=await nativeVisualContext(),question='Compare the scores',legacy=prepareDocumentAnswer(question,context),
  p=prepareDocumentAnswer(question,context,DOCUMENT_ANSWER_VISUAL_UNIT_POLICY),image=p.supports.find(s=>s.id==='i0')!,members=p.quoteUnits.filter(q=>q.supportId==='e0'),
  original=legacy.quoteUnits.find(q=>q.contextWindow?.policy==='native-region-text-windows-v1')!;
 assert.ok(image.captionMembers?.some(u=>u.text===text));assert.ok(members.every(q=>!q.selectable));
 assert.ok(p.quoteUnits.some(q=>q.supportId==='e1'&&q.selectable));assert.equal(image.nativeRegionObservation?.semanticRelationsVerified,false);
 assert.notEqual(p.fingerprint,legacy.fingerprint);assert.ok(resolveDocumentAnswerSelections({status:'answered',message:'',claims:[{text:'Fixture.',citations:[{id:original.id}]}]},legacy.supports));
 assert.throws(()=>resolveDocumentAnswerSelections({status:'answered',message:'',claims:[{text:'Fixture.',citations:[{id:original.id}]}]},p.supports),/ungrounded/);
 const generation=buildSelectedDocumentAnswerRequest(p,['i0'],{model:'gpt-5.4-mini',reasoningEffort:'low',maxOutputTokens:4000}),wire=JSON.stringify(generation);
 assert.ok(wire.includes(png.toString('base64')));assert.ok(wire.includes(text));assert.ok(!wire.includes('Other source retained.'));
 const selections={status:'answered' as const,message:'',claims:[{text:'Transport fixture only.',citations:[{id:'i0'}]}]},
  audit=prepareDocumentCitationAudit(question,context,{inputFingerprint:p.fingerprint,quoteUnitManifestSha256:p.quoteUnitManifestSha256,
   providerSelections:selections,claimIndex:0,unitPolicy:DOCUMENT_ANSWER_VISUAL_UNIT_POLICY}),request=buildDocumentCitationAuditRequest(audit.packet);
 assert.equal(audit.packet.references[0].kind,'image');assert.ok(JSON.stringify(request).includes(png.toString('base64')));assert.ok(JSON.stringify(request).includes(text));
});

test('native PDF pairing never imports a cropped, wrong-page, ambiguous, missing or unrelated original',async()=>{
 const {context}=await nativeVisualContext();
 for(const change of ['crop','page','duplicate','missing','no-native'] as const){
  const next={...context,images:context.images.map(i=>({...i}))};
  if(change==='crop')next.images[0].kind='pdf-region';
  if(change==='page')next.images[0].physicalPage=2;
  if(change==='duplicate')next.images.push({...next.images[0],attachmentId:'ambiguous'});
  if(change==='missing')next.images=[];
  if(change==='no-native')next.nativeRegionWindows=[];
  const p=prepareDocumentAnswer('Compare scores',next,DOCUMENT_ANSWER_VISUAL_UNIT_POLICY);
  assert.ok(!p.supports.some(s=>s.captionMembers?.length),change);assert.ok(p.quoteUnits.some(u=>u.supportId==='e0'&&u.selectable),change);
 }
 for(const field of ['documentId','currentVersionId','sourceVersionId','sourceHash'] as const){
  const next={...context,images:context.images.map(i=>({...i,source:{...i.source,[field]:i.source[field]+'-other'}}))};
  assert.throws(()=>prepareDocumentAnswer('Compare scores',next,DOCUMENT_ANSWER_VISUAL_UNIT_POLICY));
 }
});
