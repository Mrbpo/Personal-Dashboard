import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {recordingControlStatus,requestRecordingControl} from '../lib/recording-control.ts';
test('control publishes one atomic whitelist request and consumes only safe status metadata',async t=>{
 const root=await mkdtemp(join(tmpdir(),'recording-control-')),previous=process.env.COURSE_VIDEO_CONTROL_DIR;
 t.after(async()=>{if(previous===undefined)delete process.env.COURSE_VIDEO_CONTROL_DIR;else process.env.COURSE_VIDEO_CONTROL_DIR=previous;await rm(root,{recursive:true,force:true});});
 process.env.COURSE_VIDEO_CONTROL_DIR=root;await mkdir(join(root,'requests'));
 await writeFile(join(root,'status.json'),JSON.stringify({state:'needs_auth',reasonCode:'SESSION_EXPIRED',updatedAt:'2026-10-27T01:00:00+00:00',
  lastSuccessAt:null,authorizationActive:false,rawToken:'must-not-leak'}));
 const status=await recordingControlStatus();assert.equal(status.state,'needs_auth');assert.equal(JSON.stringify(status).includes('must-not-leak'),false);
 const [first,second]=await Promise.all([requestRecordingControl('reauthorize'),requestRecordingControl('sync')]);
 assert.equal([first,second].filter(Boolean).length,1);assert.equal((await recordingControlStatus()).pending,true);
 const request=JSON.parse(await readFile(join(root,'requests','request.json'),'utf8'));
 assert.equal(Object.keys(request).sort().join(','),'action,id,requestedAt');assert.ok(['sync','reauthorize'].includes(request.action));
 await assert.rejects(requestRecordingControl('arbitrary-shell-command'));
});
