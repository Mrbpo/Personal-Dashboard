import { kernel } from '../lib/kernel/service.ts';
import { kernelPool } from '../lib/kernel/db.ts';

const [command,id,reason] = process.argv.slice(2);
if(command==='list') console.log(JSON.stringify(await kernel.pendingCandidates(),null,2));
else if(command==='show' && id) console.log(JSON.stringify(await kernel.candidate(id),null,2));
else if((command==='accept'||command==='reject') && id && reason?.trim()){
  const actor=process.env.SUDO_USER||process.env.USER||process.env.USERNAME;
  if(!actor || actor==='root' && !process.env.SUDO_USER)throw new Error('Run under a named administrator account');
  await kernel.adjudicate(id,command,reason,actor);
  console.log(JSON.stringify({candidate:id,decision:command,actor}));
}else{
  console.error('Usage: npm run kernel:review -- list | show <candidate-id> | accept <candidate-id> "reason" | reject <candidate-id> "reason"');
  process.exitCode=2;
}
await kernelPool().end();
