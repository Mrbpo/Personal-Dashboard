import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readdir,unlink,rmdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {NATIVE_REGION_TEXT_VERSION,validateNativeRegionBundle,projectNativeRegionText,prepareNativeRegionWindows,
 readNativeRegionObservation,nativeRegionFingerprint,nativeRegionHash,type NativeRegionBundle} from '../lib/kernel/native-region-text.ts';
import {prepareDocumentAnswer,resolveDocumentAnswerSelections,validateGroundedDocumentAnswer} from '../lib/kernel/document-answer.ts';

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
