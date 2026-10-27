import {test} from 'node:test';
import assert from 'node:assert/strict';
import {studySourcePreflight,requireFinalStudySources} from '../scripts/study-source-preflight.mjs';

const a='a'.repeat(64),b='b'.repeat(64);
const source=()=>({documents:[{paperId:'1910.11235',sourceHash:a,observedVersion:'v2',officialAnnotationPdfVersionMatch:'unknown'}]});
const observation=()=>[{paperId:'1910.11235',sha256:a,nativeArxivIdentifiers:['1910.11235v2'],normalizedTitleHint:false}];

test('matching paper ID does not hide a title discrepancy or establish author-source alignment',()=>{
 const report=studySourcePreflight(source(),observation());
 assert.equal(report.records[0].nativePaperIdObserved,true);assert.equal(report.counts.titleNotObserved,1);
 assert.equal(report.records[0].observedRevision,'v2');assert.equal(report.counts.unknown,1);
 assert.throws(()=>requireFinalStudySources(report),/aligned sources/);
});
test('observed v1, matching title and a self-declared match remain unverified without an author binding',()=>{
 const input=source();input.documents[0].observedVersion='v1';input.documents[0].officialAnnotationPdfVersionMatch='matched';
 const rows=observation();rows[0].nativeArxivIdentifiers=['1910.11235v1'];rows[0].normalizedTitleHint=true;
 assert.equal(studySourcePreflight(input,rows).records[0].authorSourceAlignment,'unknown');
});
test('missing native revision remains unknown instead of inventing a version from a title',()=>{
 const input={documents:[{paperId:'1910.11235',sourceHash:a,observedVersion:null,authorSourcePdfRevision:null}]};
 const rows=observation();rows[0].nativeArxivIdentifiers=[];rows[0].normalizedTitleHint=true;
 const report=studySourcePreflight(input,rows);
 assert.equal(report.records[0].observedRevision,null);assert.equal(report.counts.unknown,1);
 assert.equal(report.finalSourceReady,false);
});
test('explicit author revision distinguishes a version mismatch from a confirmed revision binding',()=>{
 const input=source();Object.assign(input.documents[0],{authorSourcePdfRevision:'v1'});
 assert.equal(studySourcePreflight(input,observation()).counts.mismatched,1);
 Object.assign(input.documents[0],{authorSourcePdfRevision:'v2'});
 assert.doesNotThrow(()=>requireFinalStudySources(studySourcePreflight(input,observation())));
});
test('author hash mismatch cannot be overridden by a matching revision or title',()=>{
 const input=source();Object.assign(input.documents[0],{authorSourcePdfSha256:b,authorSourcePdfRevision:'v2'});
 assert.equal(studySourcePreflight(input,observation()).counts.mismatched,1);
 Object.assign(input.documents[0],{authorSourcePdfSha256:a});
 assert.equal(studySourcePreflight(input,observation()).counts.aligned,1);
});
test('stale hashes, duplicate inventories and contradictory native revisions fail before readiness',()=>{
 const wrong=observation();wrong[0].sha256=b;
 assert.throws(()=>studySourcePreflight(source(),wrong),/PDF hash/);
 const duplicate=source();duplicate.documents.push(duplicate.documents[0]);
 assert.throws(()=>studySourcePreflight(duplicate,[...observation(),...observation()]),/duplicate/);
 const changed=observation();changed[0].nativeArxivIdentifiers=['1910.11235v3'];
 assert.throws(()=>studySourcePreflight(source(),changed),/native revision/);
});
