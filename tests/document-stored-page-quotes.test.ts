import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {prepareDocumentAnswer,resolveDocumentAnswerSelections,buildDocumentEvidenceSelectionRequest,buildSelectedDocumentAnswerRequest,
 retainSelectedStoredNodeText,retainDocumentSelectionContext,DOCUMENT_STORED_PAGE_QUOTE_MAX_UTF16,type DocumentAnswerContext} from '../lib/kernel/document-answer.ts';
import {prepareDocumentCitationAudit,buildDocumentCitationAuditRequest} from '../lib/kernel/document-citation-audit.ts';
import {studyTextContextWindows} from '../lib/study-answer.ts';

const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
function inputPacket(content:unknown){
 assert.ok(Array.isArray(content));const first:unknown=content[0];
 assert.ok(first&&typeof first==='object'&&'type' in first&&'text' in first);
 assert.equal(first.type,'input_text');assert.ok(typeof first.text==='string');
 return JSON.parse(first.text);
}
function context(body:string):DocumentAnswerContext{return {sourceContentIsUntrusted:true,parents:[],images:[],anchors:[{
 id:'pg:current:2',document_id:'study',course_id:'',name:'Study',origin:'fixture',origin_key:'study',source_hash:sha('pdf'),
 source_version_id:'source-version',body,locator:'page:2',page_number:2,evidence_id:'page-two',parser_version:'docling-fixture',score:1,evidence_body:'full-page'}]};}
const selection=(id:string)=>({status:'answered' as const,message:'',claims:[{text:'A claim for binding verification only.',citations:[{id}]}]});

test('stored page quotes: opt-in preserves a complete source page through generation selection and local citation input',()=>{
 const body='The dataset consists of balanced match commentaries.\n\n'+'Original intervening paragraph. '.repeat(75)+
  '\n\nThe game language model is trained on those commentaries.';
 const c=context(body),original=JSON.stringify(c),legacy=prepareDocumentAnswer('What data is used?',c),
  enabled={...c,textQuotePolicy:'stored-page-v1' as const},prepared=prepareDocumentAnswer('What data is used?',enabled);
 assert.ok(legacy.quoteUnits.length>1);assert.ok(legacy.quoteUnits.every(q=>q.text.length<=1200));
 assert.deepEqual(prepared.quoteUnits.filter(q=>!q.pageContext),legacy.quoteUnits);
 const unit=prepared.quoteUnits.find(q=>q.pageContext)!;assert.ok(unit);assert.equal(unit.text,body);
 const restored=resolveDocumentAnswerSelections(selection(unit.id),prepared.supports);
 assert.equal(restored.answer.claims[0].citations[0].quote,body);assert.equal(restored.selectedUnits[0].endUtf16,body.length);
 assert.equal(restored.selectedUnits[0].evidence.evidenceId,'page-two');
 const audit=prepareDocumentCitationAudit('What data is used?',enabled,{inputFingerprint:prepared.fingerprint,
  quoteUnitManifestSha256:prepared.quoteUnitManifestSha256,providerSelections:selection(unit.id),claimIndex:0});
 const request=buildDocumentCitationAuditRequest(audit.packet),input=inputPacket(request.input[1].content);
 assert.equal(input.references[0].quote,body);assert.equal(input.references[0].source.locator,'page:2');
 assert.equal(audit.binding.citations[0].quoteSha256,sha(body));
 assert.equal(resolveDocumentAnswerSelections(selection(legacy.quoteUnits[0].id),prepared.supports).answer.claims[0].citations[0].quote,
  legacy.quoteUnits[0].text,'old fine IDs remain exact fine quotes, never redirects to a page');
 assert.throws(()=>prepareDocumentCitationAudit('What data is used?',c,{inputFingerprint:prepared.fingerprint,
  quoteUnitManifestSha256:prepared.quoteUnitManifestSha256,providerSelections:selection(unit.id),claimIndex:0}),/changed/);
 assert.equal(JSON.stringify(c),original,'stored text is never rewritten');
});

test('stored page quotes: fine selector IDs promote only already selected nodes before generation and count original bytes once',()=>{
 const body='Primary training data. '+'Original explanation. '.repeat(100)+'\n\nAdditional training sizes and their language-pair qualifier.',
  c=context(body);c.textQuotePolicy='stored-page-v1';
 c.anchors.push({...c.anchors[0],id:'pg:foreign:1',page_number:1,document_id:'foreign',source_version_id:'foreign-source',
  evidence_id:'foreign-page',locator:'foreign:1',body:'Foreign source marker. '.repeat(80)});
 const p=prepareDocumentAnswer('What are the training sizes?',c),page=p.quoteUnits.find(u=>u.pageContext&&u.supportId==='e0')!,
  fine=p.quoteUnits.filter(u=>!u.pageContext&&u.supportId==='e0'),settings={model:'gpt-5.4-mini' as const,reasoningEffort:'low' as const,maxOutputTokens:3000},
  selector=buildDocumentEvidenceSelectionRequest(p,settings),packet=inputPacket(selector.input.at(-1)!.content);
 assert.ok(packet.quoteUnits.every((u:any)=>!u.pageContext&&u.text.length<=1200));
 assert.ok(!selector.text.format.schema.properties.referenceIds.items.enum.includes(page.id));
 assert.throws(()=>retainSelectedStoredNodeText({referenceIds:[page.id]},p),/unoffered/);
 const kept=retainSelectedStoredNodeText({referenceIds:[fine[0].id,fine.at(-1)!.id]},p);
 assert.deepEqual(kept.providerReferenceIds,[fine[0].id,fine.at(-1)!.id]);assert.deepEqual(kept.referenceIds,[page.id]);
 assert.equal(kept.pageQuotePromotions?.[0].relation,'same-stored-page');assert.equal(kept.pageQuotePromotions?.[0].semanticRelationsVerified,false);
 const generation=buildSelectedDocumentAnswerRequest(p,kept.referenceIds,settings),input=inputPacket(generation.input.at(-1)!.content);
 assert.deepEqual(input.quoteUnits.map((u:any)=>u.id),[page.id]);assert.equal(input.quoteUnits[0].text,body);
 assert.doesNotMatch(JSON.stringify(generation.input),/Foreign source marker/);
 assert.deepEqual(generation.text.format.schema.properties.claims.items.properties.citations.items.properties.id.enum,[page.id]);
 const named=context(body);named.textQuotePolicy='stored-page-v1';named.anchors.push({...named.anchors[0],id:'pg:current:3',page_number:3,
  evidence_id:'page-three',locator:'page:3',body:'Another complete page. '.repeat(70)});
 const namedPrepared=prepareDocumentAnswer('According to Study, what data is used?',named),first=namedPrepared.quoteUnits.find(u=>!u.pageContext)!,
  retention=retainDocumentSelectionContext({referenceIds:[first.id]},namedPrepared);
 assert.equal(retention.mentionedSourceRetention?.textUtf8Bytes,Buffer.byteLength(body+named.anchors[1].body));
 assert.ok(retention.referenceIds.every(id=>namedPrepared.quoteUnits.find(u=>u.id===id)?.pageContext));
});

test('stored page quotes: bounded Unicode partitions retain every byte and never combine pages or versions',()=>{
 const body='a'.repeat(DOCUMENT_STORED_PAGE_QUOTE_MAX_UTF16-1)+'😀'+'b'.repeat(9000),c=context(body);
 c.textQuotePolicy='stored-page-v1';c.anchors.push({...c.anchors[0],id:'pg:current:3',page_number:3,evidence_id:'page-three',locator:'page:3',body:'Another page. '});
 const p=prepareDocumentAnswer('What is reported?',c),units=p.quoteUnits.filter(q=>q.supportId==='e0');
 assert.equal(units.map(q=>q.text).join(''),body);assert.ok(units.every(q=>q.text.length<=8192));
 for(let i=1;i<units.length;i++)assert.equal(units[i].startUtf16,units[i-1].endUtf16);
 assert.ok(units.every(q=>!/[\uD800-\uDBFF]$/.test(q.text)));
 const chosen=resolveDocumentAnswerSelections(selection(units[0].id),p.supports);
 assert.equal(chosen.answer.claims[0].citations[0].quote,units[0].text);
 assert.doesNotMatch(chosen.answer.claims[0].citations[0].quote,/Another page/);
 const changed=structuredClone(c);changed.anchors[0].id='pg:new-version:2';
 assert.throws(()=>resolveDocumentAnswerSelections(selection(units[0].id),prepareDocumentAnswer('What is reported?',changed).supports),/ungrounded/);
 assert.equal(studyTextContextWindows('off'),undefined);assert.equal(studyTextContextWindows('stored-page-v1'),'stored-page-v1');
 assert.throws(()=>studyTextContextWindows('page-size-arbitrary'));
});
