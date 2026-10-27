import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PDFDocument,PDFName,PDFString,type PDFObject} from 'pdf-lib';
import {observePdfInternalLinks,PDF_INTERNAL_LINK_LIMITS} from '../lib/kernel/pdf-internal-links.ts';
const key=PDFName.of;
async function fixture(){
 const pdf=await PDFDocument.create(),page=pdf.addPage([600,800]),target=pdf.addPage([600,800]);
 const destination=pdf.context.obj([target.ref,'XYZ',40,700,null]);
 const tree=pdf.context.obj({Kids:[pdf.context.obj({Names:[PDFString.of('shared'),destination]})]});
 pdf.catalog.set(key('Names'),pdf.context.obj({Dests:tree}));
 const link=(d:PDFObject)=>pdf.context.obj({Subtype:'Link',Rect:[10,20,30,40],A:{S:'GoTo',D:d}});
 page.node.set(key('Annots'),pdf.context.obj([pdf.context.register(link(PDFString.of('shared'))),link(destination),
  {Subtype:'Link',Rect:[0,0,1,1],A:{S:'URI',URI:PDFString.of('https://example.invalid/never-fetch')}}]));
 return {pdf,page,target,tree,destination,link};
}
test('original named and explicit GoTo destinations preserve page references and raw coordinates, never semantic roles',async()=>{
 const {pdf}=await fixture(),before=pdf.context.enumerateIndirectObjects().map(([ref,obj])=>[ref.toString(),obj.toString()]);
 const result=observePdfInternalLinks(pdf);
 assert.equal(result.status,'available');assert.equal(result.links.length,2);assert.equal(result.ignoredActions,1);
 assert.equal(result.semanticVerified,false);assert.equal(result.semantics,'navigation-only');
 assert.deepEqual(result.links[0].target,{status:'resolved-page',physicalPageNumber:2,view:'XYZ',parameters:[40,700,null]});
 assert.deepEqual(result.links[0].sourceRect,[10,20,30,40]);assert.equal(result.links[0].destinationName,'shared');
 assert.equal(result.links[0].sourcePageNumber,1);assert.ok(result.links[0].annotationReference?.endsWith(' R'));
 assert.deepEqual(result.links[1].target,result.links[0].target);assert.equal(result.links[1].destinationName,null);
 assert.deepEqual(pdf.context.enumerateIndirectObjects().map(([ref,obj])=>[ref.toString(),obj.toString()]),before);
});
test('duplicate names and cyclic/incomplete destination trees remain unknown; direct destinations are independent',async()=>{
 const value=await fixture();
 value.tree.set(key('Names'),value.pdf.context.obj([PDFString.of('shared'),value.destination]));
 let result=observePdfInternalLinks(value.pdf);
 assert.deepEqual(result.links[0].target,{status:'unknown',reason:'destination-name-ambiguous'});
 value.tree.set(key('Kids'),value.pdf.context.obj([value.tree]));result=observePdfInternalLinks(value.pdf);
 assert.equal(result.status,'partial');assert.equal(result.namedDestinationsComplete,false);
 assert.deepEqual(result.links[0].target,{status:'unknown',reason:'destination-tree-incomplete'});
 assert.equal(result.links[1].target.status,'resolved-page');
});
test('missing/foreign page refs and conflicting action/direct destinations are not guessed',async()=>{
 const {pdf,page,link,target}=await fixture();
 const conflict=link(PDFString.of('shared'));conflict.set(key('Dest'),pdf.context.obj([target.ref,'Fit']));
 page.node.set(key('Annots'),pdf.context.obj([link(PDFString.of('absent')),link(pdf.context.obj([0,'Fit'])),conflict]));
 const result=observePdfInternalLinks(pdf);
 assert.deepEqual(result.links.map(l=>l.target.status==='unknown'?l.target.reason:null),
  ['destination-name-missing','destination-page-not-an-original-page-ref','both-action-and-direct-destination']);
});
test('bounded scans report incomplete coverage without inventing missing links or increasing configured caps',async()=>{
 const {pdf}=await fixture();const result=observePdfInternalLinks(pdf,{...PDF_INTERNAL_LINK_LIMITS,links:1});
 assert.equal(result.links.length,1);assert.equal(result.status,'partial');assert.ok(result.notes.includes('annotation-or-link-limit'));
 assert.equal(observePdfInternalLinks(pdf,{...PDF_INTERNAL_LINK_LIMITS,pages:1}).status,'unavailable');
 assert.throws(()=>observePdfInternalLinks(pdf,{...PDF_INTERNAL_LINK_LIMITS,links:2001}),/Invalid bounded/);
});
test('opt-in link observations use existing visual manifest/Kernel read path; off unchanged and no image files needed to read links',async(t)=>{
 const {mkdtemp,unlink}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path'),
  {createHash}=await import('node:crypto'),sharp=(await import('sharp')).default;
 const directory=await mkdtemp(join(process.env.SERVICE_VAULT_DIR||tmpdir(),'goto-'));
 const old={library:process.env.LIBRARY_DIR,policy:process.env.PDF_INTERNAL_LINK_OBSERVATIONS};
 t.after(()=>{if(old.library===undefined)delete process.env.LIBRARY_DIR;else process.env.LIBRARY_DIR=old.library;
  if(old.policy===undefined)delete process.env.PDF_INTERNAL_LINK_OBSERVATIONS;else process.env.PDF_INTERNAL_LINK_OBSERVATIONS=old.policy;});
 process.env.LIBRARY_DIR=directory;process.env.DATABASE_URL=':memory:';
 const {preparePdfVisualEvidence,commitPdfVisualEvidence,readPdfInternalLinkEvidence,pdfVisualCanonical}=await import('../lib/kernel/pdf-visual-evidence.ts');
 const {pdf}=await fixture(),bytes=await pdf.save(),sha=(b:Uint8Array|string)=>createHash('sha256').update(b).digest('hex'),sourceHash=sha(bytes);
 const input={owner:'owner',documentId:'doc',sourceHash,pdfBytes:bytes,layout:{status:'unavailable' as const,regions:[],pageSizes:[]}};
 const image=await sharp({create:{width:20,height:20,channels:3,background:'#fff'}}).png().toBuffer(),render=async()=>image;
 delete process.env.PDF_INTERNAL_LINK_OBSERVATIONS;const before=await preparePdfVisualEvidence(input,render);
 process.env.PDF_INTERNAL_LINK_OBSERVATIONS='off';const off=await preparePdfVisualEvidence(input,render);
 assert.equal(before.contentSha256,off.contentSha256);assert.equal(off.content.internalLinks,undefined);
 process.env.PDF_INTERNAL_LINK_OBSERVATIONS='goto-v1';const on=await preparePdfVisualEvidence(input,render);
 assert.notEqual(on.contentSha256,off.contentSha256);assert.equal(on.content.internalLinks?.links.length,2);
 assert.deepEqual(on.content.assets,off.content.assets);
 const source={documentId:'doc',currentVersionId:'v1',sourceVersionId:'s1',sourceHash,courseId:''};let stored:any,head='v1';
 const db:any={query:async(sql:string,args:any[])=>{
  if(sql.includes('INSERT INTO document_pdf_visual_manifests')){stored={manifest:JSON.parse(args[5]),manifest_sha256:args[4],content_sha256:args[3]};return {rows:[]};}
  if(sql.startsWith('SELECT manifest_sha256'))return {rows:[{manifest_sha256:stored.manifest_sha256}]};
  if(sql.includes('FROM document_texts'))return {rows:args[0]==='owner'&&args[2]===head?[source]:[]};
  if(sql.includes('SELECT manifest,manifest_sha256'))return {rows:[stored]};throw Error('Unexpected metadata query');
 }};
 await commitPdfVisualEvidence(db,on,source,['e1','e2']);
 for(const hash of new Set(on.content.assets.map(a=>a.sha256)))await unlink(join(directory,hash));
 const read=await readPdfInternalLinkEvidence(db,'owner',source);
 assert.equal(read.status,'available');assert.equal(read.observations?.links.length,2);assert.equal(read.semanticVerified,false);
 await assert.rejects(readPdfInternalLinkEvidence(db,'foreign',source),/not current/);
 head='v2';await assert.rejects(readPdfInternalLinkEvidence(db,'owner',source),/not current/);head='v1';
 stored.manifest.content.internalLinks.semanticVerified=true;
 stored.content_sha256=sha(pdfVisualCanonical(stored.manifest.content));stored.manifest_sha256=sha(pdfVisualCanonical(stored.manifest));
 await assert.rejects(readPdfInternalLinkEvidence(db,'owner',source),/observation policy differs/);
});
