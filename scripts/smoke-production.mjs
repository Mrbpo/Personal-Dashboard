import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import {serviceFields} from '../lib/service-fields.ts';
const directory=await mkdtemp(join(tmpdir(),'study-smoke-'));
const origin='http://127.0.0.1:3107';
process.env.APP_ORIGIN=origin;
const env={...process.env,...Object.fromEntries(serviceFields.map(f=>[f.key,''])),NODE_ENV:'production',LOCAL_DEV_BYPASS_AUTH:'false',DATABASE_URL:`file:${directory.replaceAll('\\','/')}/smoke.db`,SERVICE_VAULT_DIR:join(directory,'private'),LIBRARY_DIR:join(directory,'library'),OWNER_ACCESS_KEY:'isolated-smoke-password',SESSION_SECRET:'isolated-smoke-session',DASHBOARD_API_TOKEN:'',CLOUD_MODE:'true'};
const child=spawn(process.execPath,['node_modules/next/dist/bin/next','start','-H','127.0.0.1','-p','3107'],{env,stdio:['ignore','pipe','pipe']});
let log='';child.stdout.on('data',b=>{log+=b.toString();});child.stderr.on('data',b=>{log+=b.toString();});
let worker;
try{
 let ready=false;for(let i=0;i<60;i++){if(child.exitCode!==null)throw new Error('Isolated server exited');try{if((await fetch(origin+'/api/health/live')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,500));}assert.ok(ready,'server startup');
 for(const path of ['/api/tutor','/api/library','/api/library/search?q=smoke','/api/library/failures','/api/mail','/api/deployments','/api/deployments/check','/api/jobs'])assert.equal((await fetch(origin+path)).status,401,path);
 const login=await fetch(origin+'/api/auth/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({accessKey:env.OWNER_ACCESS_KEY})});assert.equal(login.status,200);
 const cookie=login.headers.get('set-cookie').split(';')[0],headers={Cookie:cookie,Origin:origin};
 assert.equal((await fetch(origin+'/api/tutor',{method:'POST',headers:{...headers,Origin:'https://wrong.invalid','Content-Type':'application/json'},body:'{}'})).status,403);
 for(const path of ['/study','/library','/mail','/settings'])assert.equal((await fetch(origin+path,{headers})).status,200,path);
 const create=await fetch(origin+'/api/tutor',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:'{"courseId":""}'});assert.equal(create.status,200);
 const form=new FormData();form.set('file',new Blob(['isolated smoke document']),'smoke.txt');
  const upload=await fetch(origin+'/api/library',{method:'POST',headers,body:form});assert.equal(upload.status,200);const {id}=await upload.json();
  worker=spawn(process.execPath,['--experimental-strip-types','scripts/worker.ts'],{env:{...env,SYNC_PRIMARY:'false'},stdio:'ignore'});
  let parsed=false;
  for(let i=0;i<30;i++){
    const response=await fetch(origin+'/api/library',{headers});
    const body=await response.text();
    assert.equal(response.status,200,`library polling failed: ${body}`);
    const docs=JSON.parse(body);
    assert.ok(Array.isArray(docs),`library polling returned a non-list response: ${body}`);
    if(docs.find(d=>d.id===id)?.status==='ready'){parsed=true;break;}
    await new Promise(r=>setTimeout(r,500));
  }
  assert.ok(parsed,'independent worker parsed queued document');
 const search=await fetch(origin+'/api/library/search?q=isolated',{headers});assert.equal(search.status,200);assert.equal((await search.json()).matches[0].document_id,id);
 assert.equal((await fetch(origin+'/api/library/'+id)).status,401);
 const download=await fetch(origin+'/api/library/'+id,{headers});assert.equal(download.status,200);assert.equal(await download.text(),'isolated smoke document');
 assert.equal((await fetch(origin+'/api/library/'+id,{method:'DELETE',headers})).status,200);
 assert.notEqual((await fetch(origin+'/api/library/'+id,{headers})).status,200);
 console.log('Production smoke passed: authentication, CSRF, pages, independent worker, private upload/download and deletion. No provider calls.');
}catch(error){
 process.stderr.write(`\n--- isolated production server log ---\n${log}\n--- end server log ---\n`);
 throw error;
}finally{
 if(worker){worker.kill();await Promise.race([new Promise(r=>worker.once('exit',r)),new Promise(r=>setTimeout(r,5000))]);if(worker.exitCode===null)worker.kill('SIGKILL');}
 child.kill();await Promise.race([new Promise(r=>child.once('exit',r)),new Promise(r=>setTimeout(r,5000))]);
 if(child.exitCode===null)child.kill('SIGKILL');
 // This directory was created above solely for the smoke test.
 await rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:500});
}
