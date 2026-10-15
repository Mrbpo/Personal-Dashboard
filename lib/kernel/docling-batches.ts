import {mkdir,writeFile,rename,unlink} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {digest,readBlob} from '../library.ts';
import {decodeDoclingResult} from './docling-result.ts';

export type DoclingIdentity={owner:string;documentId:string;sourceHash:string;optionsHash:string;totalPages:number};
export type DoclingBatch={start:number;end:number;taskId?:string;resultHash?:string;inputHash?:string;copyIndices?:number[]};
export type DoclingProgress={schema:1;identity:DoclingIdentity;batchSize:number;batches:DoclingBatch[]};
export type DecodedDocling=ReturnType<typeof decodeDoclingResult>;

export function createDoclingProgress(identity:DoclingIdentity,batchSize=Number(process.env.DOCLING_BATCH_PAGES||1)):DoclingProgress{
  if(!Number.isInteger(batchSize)||batchSize<1||batchSize>4)throw new Error('DOCLING_BATCH_PAGES must be an integer from 1 to 4');
  return {schema:1,identity,batchSize,batches:Array.from({length:Math.ceil(identity.totalPages/batchSize)},(_,i)=>
    ({start:i*batchSize+1,end:Math.min((i+1)*batchSize,identity.totalPages)}))};
}
export function validateDoclingProgress(value:unknown,identity:DoclingIdentity):DoclingProgress{
  const p=value as DoclingProgress;
  const expected=createDoclingProgress(identity,p?.batchSize);
  if(!p||p.schema!==1||p.batchSize!==expected.batchSize||!p.identity||
    Object.entries(identity).some(([key,v])=>p.identity[key as keyof DoclingIdentity]!==v)||
    !Array.isArray(p.batches)||p.batches.length!==expected.batches.length||
    p.batches.some((batch,index)=>!batch||batch.start!==expected.batches[index].start||batch.end!==expected.batches[index].end||
      (batch.taskId!==undefined&&(typeof batch.taskId!=='string'||!batch.taskId||batch.taskId.length>1000))||
      (batch.resultHash!==undefined&&!/^[a-f0-9]{64}$/.test(batch.resultHash))||
      (batch.inputHash!==undefined&&!/^[a-f0-9]{64}$/.test(batch.inputHash))||
      (batch.copyIndices!==undefined&&(!Array.isArray(batch.copyIndices)||batch.copyIndices.length!==batch.end-batch.start+1||
        batch.copyIndices.some((page,i)=>page!==batch.start+i-1)))||
      ((batch.taskId!==undefined||batch.resultHash!==undefined)&&(!batch.inputHash||!batch.copyIndices))))
    throw new Error('Docling staged identity or range plan mismatch');
  return structuredClone(p);
}

export function decodeDerivedDoclingResult(result:unknown,mapping:{start:number;end:number;totalPages:number;copyIndices:number[]},
  options:{verifiedBlankPages:number[];formulaEnriched:boolean}):DecodedDocling{
  const count=mapping.end-mapping.start+1;
  if(!Number.isInteger(mapping.start)||!Number.isInteger(mapping.end)||mapping.start<1||mapping.end>mapping.totalPages||count<1||
    mapping.copyIndices.length!==count||mapping.copyIndices.some((index,i)=>index!==mapping.start+i-1))
    throw new Error('Docling derived page mapping is invalid');
  const decoded=decodeDoclingResult(result,count,{pageRange:[1,count],formulaEnriched:options.formulaEnriched,
    verifiedBlankPages:mapping.copyIndices.flatMap((index,i)=>options.verifiedBlankPages.includes(index+1)?[i+1]:[])});
  const original=(local:number)=>mapping.copyIndices[local-1]+1;
  return {...decoded,totalPages:mapping.totalPages,
    pages:decoded.pages.map(page=>({...page,pageNumber:original(page.pageNumber),locator:`第 ${original(page.pageNumber)} 页`})),
    formulaPageNumbers:decoded.formulaPageNumbers.map(original),
    visualLayout:{...decoded.visualLayout,pageSizes:decoded.visualLayout.pageSizes.map(page=>({...page,pageNumber:original(page.pageNumber)})),
      regions:decoded.visualLayout.regions.map(region=>({...region,pageNumber:original(region.pageNumber),copyIndices:[...mapping.copyIndices]}))},
    warnings:decoded.warnings.map(warning=>warning.replace(/第 (\d+) 页/g,(_,local)=>`第 ${original(Number(local))} 页`))};
}

// Atomic rename avoids publishing a pointer to a partially written staging blob.
// Staging has no library document row and is never included in search.
export async function storeDoclingResult(value:unknown):Promise<string>{
  const bytes=Buffer.from(JSON.stringify(value)),hash=digest(bytes);
  const root=resolve(process.env.LIBRARY_DIR||'./data/library');
  await mkdir(root,{recursive:true,mode:0o700});
  const temporary=resolve(root,`.docling-${randomUUID()}.tmp`);
  try{
    await writeFile(temporary,bytes,{mode:0o600});
    await rename(temporary,resolve(root,hash));
    if(digest(await readBlob(hash))!==hash)throw new Error('Docling staging blob checksum mismatch');
  }finally{await unlink(temporary).catch(()=>{});}
  return hash;
}

export async function requestDoclingResult(endpoint:string,headers:HeadersInit,form:FormData|undefined,
  taskId:string|undefined,remember:(taskId:string|null)=>Promise<void>):Promise<Record<string,unknown>>{
  let task:{task_id?:string;task_status?:string}={task_id:taskId};
  if(!task.task_id){
    if(!form)throw new Error('Legacy Docling task is unavailable; retry with bounded ranges');
    const response=await fetch(`${endpoint}/v1/convert/file/async`,{method:'POST',headers,body:form,signal:AbortSignal.timeout(120000)});
    if(!response.ok)throw new Error(`Docling submit failed (${response.status})`);
    task=await response.json() as typeof task;
    if(typeof task.task_id!=='string'||!task.task_id)throw new Error('Docling did not return a task id');
    await remember(task.task_id);
  }
  let state=task.task_status,transient=0;
  const until=Date.now()+15*60000;
  while(Date.now()<until&&state!=='success'&&state!=='failure'){
    await new Promise(resolve=>setTimeout(resolve,5000));
    let response:Response;
    try{response=await fetch(`${endpoint}/v1/status/poll/${encodeURIComponent(task.task_id!)}`,{headers,signal:AbortSignal.timeout(30000)});}
    catch(error){if(++transient>8)throw error;continue;}
    if(response.status>=500&&++transient<=8)continue;
    transient=0;
    if(!response.ok){
      if(response.status===404){
        await remember(null);
        // Only an old resumed task can be replaced, using its already verified
        // derived form. The fresh call has no taskId, so a second 404 must fail.
        if(taskId&&form)return requestDoclingResult(endpoint,headers,form,undefined,remember);
      }
      throw new Error(`Docling poll failed (${response.status})`);
    }
    state=(await response.json() as {task_status?:string}).task_status;
  }
  if(state!=='success'){
    if(state==='failure')await remember(null);
    throw new Error(`Docling conversion ${state||'timed out'}`);
  }
  const response=await fetch(`${endpoint}/v1/result/${encodeURIComponent(task.task_id!)}`,{headers,signal:AbortSignal.timeout(30000)});
  if(!response.ok){
    if(response.status===404){
      await remember(null);
      if(taskId&&form)return requestDoclingResult(endpoint,headers,form,undefined,remember);
    }
    throw new Error(`Docling result failed (${response.status})`);
  }
  return await response.json() as Record<string,unknown>;
}

export async function convertDoclingBatches(input:{identity:DoclingIdentity;progress?:unknown;verifiedBlankPages:number[];
  formulaEnriched:boolean;endpoint:string;headers:HeadersInit;
  prepare:(start:number,end:number)=>Promise<{form:FormData;inputHash:string;copyIndices:number[]}>;
  persist:(progress:DoclingProgress)=>Promise<void>}):Promise<DecodedDocling>{
  const progress=input.progress?validateDoclingProgress(input.progress,input.identity):createDoclingProgress(input.identity);
  await input.persist(progress);
  const pages:DecodedDocling['pages']=[],warnings=new Set<string>(),formulaPages=new Set<number>();
  const visualLayout:DecodedDocling['visualLayout']={status:'available',regions:[],pageSizes:[]};
  for(const batch of progress.batches){
    const prepared=await input.prepare(batch.start,batch.end);
    if(!/^[a-f0-9]{64}$/.test(prepared.inputHash)||prepared.copyIndices.length!==batch.end-batch.start+1||
      prepared.copyIndices.some((page,i)=>page!==batch.start+i-1)||
      (batch.inputHash!==undefined&&batch.inputHash!==prepared.inputHash)||
      (batch.copyIndices!==undefined&&JSON.stringify(batch.copyIndices)!==JSON.stringify(prepared.copyIndices)))
      throw new Error('Docling derived input identity mismatch');
    batch.inputHash=prepared.inputHash;batch.copyIndices=[...prepared.copyIndices];
    const identity={...input.identity,start:batch.start,end:batch.end,inputHash:prepared.inputHash,copyIndices:prepared.copyIndices};
    const decode=(result:unknown)=>decodeDerivedDoclingResult(result,{...identity},
      {verifiedBlankPages:input.verifiedBlankPages,formulaEnriched:input.formulaEnriched});
    let decoded:DecodedDocling|undefined;
    if(batch.resultHash){
      try{
        const bytes=await readBlob(batch.resultHash);
        if(digest(bytes)!==batch.resultHash)throw new Error('Docling staging blob checksum mismatch');
        const saved=JSON.parse(bytes.toString('utf8'));
        if(JSON.stringify(saved.identity)!==JSON.stringify(identity))throw new Error('Docling staging blob identity mismatch');
        decoded=decode(saved.result);
      }catch{
        // A lost/corrupt draft cannot justify publication. Reparse this range only.
        delete batch.resultHash;delete batch.taskId;await input.persist(progress);
      }
    }
    if(!decoded){
      const blank=Array.from({length:batch.end-batch.start+1},(_,i)=>batch.start+i)
        .every(page=>input.verifiedBlankPages.includes(page));
      if(blank){
        decoded={pages:Array.from({length:batch.end-batch.start+1},(_,i)=>({pageNumber:batch.start+i,
          locator:`第 ${batch.start+i} 页`,text:''})),totalPages:input.identity.totalPages,
          warnings:[`第 ${batch.start}–${batch.end} 页已核验原始 PDF 无页面内容，保留为空白页`],formulaPageNumbers:[],
          visualLayout:{status:'unavailable',regions:[],pageSizes:[],reason:'Blank range had no layout conversion'}};
        await input.persist(progress);
      }else{
        // Pin input bytes and explicit source indices before submitting or resuming.
        await input.persist(progress);
        const result=await requestDoclingResult(input.endpoint,input.headers,prepared.form,batch.taskId,
          async taskId=>{if(taskId)batch.taskId=taskId;else delete batch.taskId;await input.persist(progress);});
        try{decoded=decode(result);}
        catch(error){delete batch.taskId;await input.persist(progress);throw error;}
        batch.resultHash=await storeDoclingResult({identity,result});delete batch.taskId;
        await input.persist(progress);
      }
    }
    pages.push(...decoded.pages);decoded.warnings.forEach(w=>warnings.add(w));decoded.formulaPageNumbers.forEach(p=>formulaPages.add(p));
    if(decoded.visualLayout.status==='unavailable'){visualLayout.status='unavailable';visualLayout.reason=decoded.visualLayout.reason;}
    visualLayout.pageSizes.push(...decoded.visualLayout.pageSizes);
    if(decoded.visualLayout.unavailablePictures)visualLayout.unavailablePictures=[...(visualLayout.unavailablePictures||[]),...decoded.visualLayout.unavailablePictures];
    if(batch.resultHash)visualLayout.resultReferences=[...(visualLayout.resultReferences||[]),{resultBlobSha256:batch.resultHash,
      derivedInputSha256:prepared.inputHash,copyIndices:[...prepared.copyIndices]}];
    visualLayout.regions.push(...decoded.visualLayout.regions.map(region=>({...region,resultBlobSha256:batch.resultHash,
      derivedInputSha256:prepared.inputHash,copyIndices:[...prepared.copyIndices]})));
  }
  if(pages.length!==input.identity.totalPages||pages.some((page,i)=>page.pageNumber!==i+1)||!pages.some(page=>page.text.trim()))
    throw new Error('Document transcription is incomplete');
  return {pages,totalPages:input.identity.totalPages,warnings:[...warnings],formulaPageNumbers:[...formulaPages],visualLayout};
}
