import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
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

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
  const args=process.argv.slice(2),options=new Map();let final=false;
  for(let i=0;i<args.length;i++){
   if(args[i]==='--final'){if(final)throw Error('Duplicate final flag');final=true;continue;}
   if(!['--manifest','--metadata','--output'].includes(args[i])||!args[i+1]||options.has(args[i]))throw Error('Invalid preflight arguments');
   options.set(args[i],args[++i]);
  }
  if(!['--manifest','--metadata','--output'].every(key=>options.has(key)))throw Error('Provide --manifest, --metadata and --output');
  const manifest=await readFile(options.get('--manifest')),metadata=await readFile(options.get('--metadata'));
  const report={...studySourcePreflight(JSON.parse(manifest),JSON.parse(metadata)),
   inputs:{manifestSha256:hash(manifest),metadataSha256:hash(metadata)},mode:final?'final':'calibration'};
  await writeFile(options.get('--output'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({version:report.version,counts:report.counts,finalSourceReady:report.finalSourceReady,mode:report.mode}));
  if(final){try{requireFinalStudySources(report);}catch(error){console.error(error.message);process.exitCode=2;}}
 }catch(error){console.error(error.message);process.exitCode=1;}
}
