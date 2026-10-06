import {kernelPool,migrateKernel} from '../lib/kernel/db.ts';
import {kernel} from '../lib/kernel/service.ts';
import {indexDocument,listDocuments} from '../lib/library.ts';

const args=process.argv.slice(2);
const value=(name:string)=>{const at=args.indexOf(name);return at<0?'':args[at+1]||'';};
const owner=value('--owner');
if(!owner)throw new Error('Usage: npm run pdf:reindex -- --owner <owner-id> [--course <id>] [--limit <count>] [--offset <count>]');
const limit=Number(value('--limit')||20);
if(!Number.isInteger(limit)||limit<1||limit>500)throw new Error('limit must be between 1 and 500');
const offset=Number(value('--offset')||0);
if(!Number.isInteger(offset)||offset<0)throw new Error('offset must be a non-negative integer');
await migrateKernel();
try{
  const all=(await listDocuments(owner)).filter(row=>row.mime==='application/pdf'&&(!value('--course')||row.course_id===value('--course')));
  const documents=all.slice(offset,offset+limit);
  for(const document of documents){
    if(args.includes('--rebuild-search'))await kernel.rebuildDocumentSearch(owner,document.id);
    else await indexDocument(owner,document.id,true);
    console.log(JSON.stringify({documentId:document.id,name:document.name,status:args.includes('--rebuild-search')?'rebuilt':process.env.DOCLING_URL?'queued':'parsed'}));
  }
  console.log(JSON.stringify({count:documents.length,nextOffset:offset+documents.length,total:all.length}));
}finally{await kernelPool().end();}
