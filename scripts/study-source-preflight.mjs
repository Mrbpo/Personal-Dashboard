import {readFile,writeFile,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,relative,isAbsolute,posix} from 'node:path';
import {fileURLToPath} from 'node:url';

export const STUDY_SOURCE_PREFLIGHT_VERSION='study-source-alignment-preflight-v1';
const hash=value=>createHash('sha256').update(value).digest('hex');
const isHash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const revision=value=>typeof value==='string'&&/^v[1-9]\d*$/.test(value);

/** Metadata precondition only. Neither title presence nor a matching arXiv ID
 * establishes which PDF revision underlies the independent author source. */
export function studySourcePreflight(manifest,observations){
 const documents=manifest?.documents;
 if(!Array.isArray(documents)||!documents.length||!Array.isArray(observations)||observations.length!==documents.length)
  throw Error('Source and observation inventories must be nonempty and complete');
 const byId=new Map();
 for(const row of observations){
  if(!row||typeof row.paperId!=='string'||byId.has(row.paperId)||!isHash(row.sha256)||
   !Array.isArray(row.nativeArxivIdentifiers)||row.nativeArxivIdentifiers.some(id=>typeof id!=='string')||
   ![true,false,undefined].includes(row.normalizedTitleHint))throw Error('Invalid or duplicate PDF observation');
  byId.set(row.paperId,row);
 }
 const seen=new Set(),records=[];
 for(const source of documents){
  if(!source||typeof source.paperId!=='string'||!/^\d{4}\.\d{4,5}$/.test(source.paperId)||seen.has(source.paperId)||!isHash(source.sourceHash))
   throw Error('Invalid or duplicate source identity');
  seen.add(source.paperId);const row=byId.get(source.paperId);
  if(!row||row.sha256!==source.sourceHash)throw Error('Cached observation is not bound to the source PDF hash');
  if(source.observedVersion!=null&&!revision(source.observedVersion))throw Error('Invalid observed revision');
  const identifiers=row.nativeArxivIdentifiers.map(id=>id.match(/^(\d{4}\.\d{4,5})(v[1-9]\d*)?$/));
  if(identifiers.some(id=>!id))throw Error('Invalid native PDF identifier');
  const matching=identifiers.filter(id=>id[1]===source.paperId),versions=[...new Set(matching.flatMap(id=>id[2]?[id[2]]:[]))];
  const observedRevision=versions.length===1?versions[0]:null;
  if(observedRevision&&source.observedVersion&&observedRevision!==source.observedVersion)
   throw Error('Declared observation disagrees with the native revision');
  if(source.authorSourcePdfSha256!=null&&!isHash(source.authorSourcePdfSha256))throw Error('Invalid author-source PDF hash');
  if(source.authorSourcePdfRevision!=null&&!revision(source.authorSourcePdfRevision))throw Error('Invalid author-source PDF revision');
  const issues=[];
  if(!matching.length)issues.push('native-paper-id-not-observed');
  if(versions.length>1)issues.push('native-revision-ambiguous');
  if(row.normalizedTitleHint===false)issues.push('expected-title-not-observed');
  let alignment='unknown',basis=null;
  if(source.authorSourcePdfSha256!=null){
   alignment=source.authorSourcePdfSha256===source.sourceHash?'aligned':'mismatched';basis='explicit-author-source-pdf-hash';
  }
  if(source.authorSourcePdfRevision!=null){
   if(observedRevision){
    const same=source.authorSourcePdfRevision===observedRevision;
    if(!same){alignment='mismatched';issues.push('author-source-revision-differs');}
    else if(alignment!=='mismatched')alignment='aligned';
    basis=basis?'explicit-author-source-pdf-hash-and-revision':'explicit-author-source-revision';
   }else if(alignment==='unknown')issues.push('author-source-revision-not-verifiable');
  }
  if(versions.length>1&&alignment==='aligned')alignment='unknown';
  if(alignment==='mismatched')issues.push('author-source-alignment-mismatch');
  if(alignment==='unknown')issues.push('author-source-alignment-unverified');
  records.push({paperId:source.paperId,rawPdfSha256:source.sourceHash,
   nativePaperIdObserved:matching.length>0,observedRevision,
   titleHint:row.normalizedTitleHint===undefined?'unknown':row.normalizedTitleHint?'observed':'not-observed',
   authorSourceAlignment:alignment,alignmentBasis:basis,issues,
   contentFidelity:'unassessed',answerCorrectness:'unassessed'});
 }
 const counts={sources:records.length,aligned:0,unknown:0,mismatched:0,titleNotObserved:0};
 for(const row of records){counts[row.authorSourceAlignment]++;if(row.titleHint==='not-observed')counts.titleNotObserved++;}
 return {version:STUDY_SOURCE_PREFLIGHT_VERSION,counts,finalSourceReady:counts.aligned===counts.sources,
  meaning:'Source prerequisite only; not proof of parsing, retrieval, answer, citation or refusal accuracy.',records};
}

export function requireFinalStudySources(report){
 if(report.version!==STUDY_SOURCE_PREFLIGHT_VERSION||!report.finalSourceReady||report.counts.unknown||report.counts.mismatched)
  throw Error('Final study acceptance requires aligned sources; retain unresolved cases and resolve their material binding first');
}

const gitHash=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value);
const artifactPath=value=>typeof value==='string'&&value.length>0&&value.length<=4000&&
 !/[\\:\u0000-\u001f]/u.test(value)&&!value.split('/').some(part=>!part||part==='.'||part==='..');
const gitBlob=bytes=>createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');

/** Offline adapter for a publisher's commit-pinned PDF + array/doc_id release.
 * Expected blobs must come from an independently captured publisher inventory.
 * Only doc_id is inspected; question/answer content is never emitted or graded.
 * A title, inferred revision or locally invented annotation cannot bind a PDF. */
export async function publishedStudySourcePreflight(bundle,readArtifact){
 if(bundle?.protocol!=='publisher-git-pdf-bundle-v1'||
  typeof bundle.repository!=='string'||!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(bundle.repository)||
  !gitHash(bundle.commit)||typeof readArtifact!=='function'||
  !artifactPath(bundle.annotations?.path)||!gitHash(bundle.annotations?.gitBlobSha1)||
  !Array.isArray(bundle.documents)||!bundle.documents.length)
  throw Error('Invalid publisher PDF bundle');
 const ids=new Set(),paths=new Set();
 for(const row of bundle.documents){
  if(!row||typeof row.documentId!=='string'||!artifactPath(row.documentId)||row.documentId.includes('/')||
   !artifactPath(row.path)||posix.basename(row.path)!==row.documentId||!row.path.endsWith('.pdf')||
   row.path===bundle.annotations.path||!gitHash(row.gitBlobSha1)||
   !Number.isSafeInteger(row.bytes)||row.bytes<=0||ids.has(row.documentId)||paths.has(row.path))
   throw Error('Invalid or duplicate publisher document identity');
  ids.add(row.documentId);paths.add(row.path);
 }
 const annotations=await readArtifact(bundle.annotations.path);
 if(!Buffer.isBuffer(annotations))throw Error('Publisher artifacts must be raw bytes');
 const actualAnnotationBlob=gitBlob(annotations),annotationVerified=actualAnnotationBlob===bundle.annotations.gitBlobSha1;
 const referenced=new Set();
 if(annotationVerified){
  let rows;try{rows=JSON.parse(annotations.toString('utf8'));}catch{throw Error('Invalid publisher annotation JSON');}
  if(!Array.isArray(rows)||!rows.length||rows.some(row=>!row||typeof row.doc_id!=='string'||!row.doc_id))
   throw Error('Publisher annotations must be a nonempty array with document IDs');
  for(const row of rows)referenced.add(row.doc_id);
 }
 const records=[];
 for(const row of bundle.documents){
  const bytes=await readArtifact(row.path);
  if(!Buffer.isBuffer(bytes))throw Error('Publisher artifacts must be raw bytes');
  const actualBlob=gitBlob(bytes),issues=[];
  if(!annotationVerified)issues.push('publisher-annotation-blob-mismatch');
  if(bytes.length!==row.bytes||actualBlob!==row.gitBlobSha1)issues.push('publisher-pdf-blob-mismatch');
  if(!bytes.subarray(0,5).equals(Buffer.from('%PDF-')))issues.push('publisher-artifact-not-raw-pdf');
  if(annotationVerified&&!referenced.has(row.documentId))issues.push('publisher-document-id-not-referenced');
  const mismatch=issues.some(issue=>issue!=='publisher-document-id-not-referenced');
  records.push({documentId:row.documentId,rawPdfSha256:hash(bytes),bytes:bytes.length,
   publisherPdfPath:row.path,publisherPdfBlobSha1:row.gitBlobSha1,actualPdfBlobSha1:actualBlob,
   authorSourceAlignment:mismatch?'mismatched':issues.length?'unknown':'aligned',
   alignmentBasis:'publisher-pinned-annotation-doc-id-and-pdf-blob',issues,
   contentFidelity:'unassessed',answerCorrectness:'unassessed'});
 }
 const counts={sources:records.length,aligned:0,unknown:0,mismatched:0,titleNotObserved:0};
 for(const row of records)counts[row.authorSourceAlignment]++;
 return {version:STUDY_SOURCE_PREFLIGHT_VERSION,sourceBindingProtocol:bundle.protocol,
  publisher:{repository:bundle.repository,commit:bundle.commit,annotationPath:bundle.annotations.path,
   expectedAnnotationBlobSha1:bundle.annotations.gitBlobSha1,actualAnnotationBlobSha1:actualAnnotationBlob,
   annotationSha256:hash(annotations)},scope:'listed-document-ids-only',
  validatedDocumentIds:records.filter(row=>row.authorSourceAlignment==='aligned').map(row=>row.documentId),
  fullPublisherDatasetValidated:false,counts,finalSourceReady:counts.aligned===counts.sources,records,
  meaning:'Publisher artifact association only; not proof of parsing, retrieval, answer, citation or refusal accuracy.'};
}

export async function readPublishedStudyArtifact(root,path){
 if(!artifactPath(path))throw Error('Invalid publisher artifact path');
 const base=await realpath(root),target=await realpath(resolve(base,...path.split('/'))),inside=relative(base,target);
 if(!inside||inside==='..'||inside.startsWith('..\\')||inside.startsWith('../')||isAbsolute(inside))
  throw Error('Publisher artifact is outside its local bundle root');
 return readFile(target);
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
  const args=process.argv.slice(2),options=new Map();let final=false;
  for(let i=0;i<args.length;i++){
   if(args[i]==='--final'){if(final)throw Error('Duplicate final flag');final=true;continue;}
   if(!['--manifest','--metadata','--publisher-bundle','--bundle-root','--output'].includes(args[i])||!args[i+1]||options.has(args[i]))throw Error('Invalid preflight arguments');
   options.set(args[i],args[++i]);
  }
  let result,inputs;
  if(options.has('--publisher-bundle')||options.has('--bundle-root')){
   if(!['--publisher-bundle','--bundle-root','--output'].every(key=>options.has(key))||options.has('--manifest')||options.has('--metadata'))
    throw Error('Provide --publisher-bundle, --bundle-root and --output without arXiv inputs');
   const bytes=await readFile(options.get('--publisher-bundle'));
   result=await publishedStudySourcePreflight(JSON.parse(bytes),path=>readPublishedStudyArtifact(options.get('--bundle-root'),path));
   inputs={publisherBundleManifestSha256:hash(bytes)};
  }else{
   if(!['--manifest','--metadata','--output'].every(key=>options.has(key)))throw Error('Provide --manifest, --metadata and --output');
   const manifest=await readFile(options.get('--manifest')),metadata=await readFile(options.get('--metadata'));
   result=studySourcePreflight(JSON.parse(manifest),JSON.parse(metadata));
   inputs={manifestSha256:hash(manifest),metadataSha256:hash(metadata)};
  }
  const report={...result,inputs,mode:final?'final':'calibration'};
  await writeFile(options.get('--output'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({version:report.version,counts:report.counts,finalSourceReady:report.finalSourceReady,mode:report.mode}));
  if(final){try{requireFinalStudySources(report);}catch(error){console.error(error.message);process.exitCode=2;}}
 }catch(error){console.error(error.message);process.exitCode=1;}
}
