// Public-source preparation only: deliberately imports no application, DB or AI code.
import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises';
import {resolve,join,basename} from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';

const root=resolve(process.env.PDF_FRESH_DIR||'data/pdf-fresh-20261013');
const python=process.env.PDF_PREP_PYTHON||'C:/Users/Byz/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe';
const maxBytes=200*1024*1024;
const courses=[
 {group:'ml6867',slug:'6-867-machine-learning-fall-2006',title:'MIT 6.867 Machine Learning, Fall 2006',categories:['lecture-notes','problem-sets','problem-set-solutions','readings','exams','exam-solutions']},
 {group:'algorithms6046',slug:'6-046j-design-and-analysis-of-algorithms-spring-2015',title:'MIT 6.046J Design and Analysis of Algorithms, Spring 2015',categories:['lecture-notes','recitations','problem-sets','problem-set-solutions','exams','exam-solutions']},
 {group:'systems6004',slug:'6-004-computation-structures-spring-2009',title:'MIT 6.004 Computation Structures, Spring 2009',categories:['lecture-notes','problem-sets','problem-set-solutions','laboratory-assignments','exams','exam-solutions']},
];
const sha=value=>createHash('sha256').update(value).digest('hex');
const json=(path,value)=>writeFile(path,JSON.stringify(value,null,2)+'\n');
const plain=value=>value.replace(/<[^>]+>/g,' ').replace(/&amp;/g,'&').replace(/&#39;/g,"'").replace(/&quot;/g,'"').replace(/&nbsp;/g,' ').replace(/\s+/g,' ').trim();
async function get(url){
 const u=new URL(url);if(u.hostname!=='ocw.mit.edu'||u.protocol!=='https:')throw new Error('Only official public OCW sources allowed');
 const response=await fetch(url,{signal:AbortSignal.timeout(45000)});
 if(!response.ok)throw new Error(`Download failed ${response.status}: ${url}`);
 if(new URL(response.url).hostname!=='ocw.mit.edu')throw new Error('External redirect refused');
 return response;
}
await mkdir(root,{recursive:true});
if(process.argv.includes('--discover')){
 const catalog=[];
 for(const course of courses){
  const dir=join(root,course.group);await mkdir(dir,{recursive:true});
  const byUrl=new Map();
  for(const category of ['download',...course.categories]){
   const url=`https://ocw.mit.edu/courses/${course.slug}/${category==='download'?'download/':`resources/${category}/`}`;
   let html;try{html=await (await get(url)).text();}catch(error){if(category==='download')throw error;console.log(JSON.stringify({action:'category-unavailable',group:course.group,category,error:error.message}));continue;}
   await writeFile(join(dir,`source-${category}.html`),html);
   for(const [,attributes,inner] of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)){
    const href=attributes.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1];if(!href)continue;
    const target=new URL(href.replace(/&amp;/g,'&'),url);if(target.hostname!=='ocw.mit.edu'||!target.pathname.endsWith('.pdf')||!target.pathname.startsWith(`/courses/${course.slug}/`))continue;
    const source_url=target.href,path=basename(target.pathname).replace(/^[a-f0-9]{32}_/,'');
    const old=byUrl.get(source_url)||{group:course.group,path,title:plain(inner)||path,source_url,categories:[],courseTitle:course.title};
    if(!old.categories.includes(category))old.categories.push(category);
    byUrl.set(source_url,old);
   }
  }
  for(const page of ['syllabus','calendar']){
   const url=`https://ocw.mit.edu/courses/${course.slug}/pages/${page}/`;
   try{const html=await (await get(url)).text();await writeFile(join(dir,`${page}.source.html`),html);await json(join(dir,`${page}.source.json`),{source_url:url,sha256:sha(html),kind:'official-html',original:true});}catch(error){console.log(JSON.stringify({action:'page-unavailable',group:course.group,page,error:error.message}));}
  }
  catalog.push(...byUrl.values());
 }
 await json(join(root,'source-catalog.json'),catalog);
 console.log(JSON.stringify({action:'discovered',groups:courses.map(course=>({group:course.group,pdfs:catalog.filter(item=>item.group===course.group).length}))}));
}
if(process.argv.includes('--download')){
 const catalog=JSON.parse(await readFile(join(root,'source-catalog.json'),'utf8'));
 const selection=JSON.parse(await readFile(join(root,'source-selection.json'),'utf8'));
 let total=0;for(const course of courses)for(const entry of await readdir(join(root,course.group),{withFileTypes:true}))if(entry.isFile()&&entry.name.endsWith('.pdf'))total+=(await readFile(join(root,course.group,entry.name))).length;
 for(const course of courses){
  const wanted=selection[course.group];if(!Array.isArray(wanted)||wanted.length<10)throw new Error(`Insufficient multi-document selection: ${course.group}`);
  const records=[];const hashes=new Set();
  for(const path of wanted){
   const source=catalog.find(item=>item.group===course.group&&item.path===path);if(!source)throw new Error('Selected source absent from official catalog');
   const destination=join(root,course.group,path);let bytes;
   try{bytes=await readFile(destination);}catch(error){if(error.code!=='ENOENT')throw error;const response=await get(source.source_url);const length=Number(response.headers.get('content-length'));if(length>maxBytes-total)throw new Error('200 MiB download cap reached');bytes=Buffer.from(await response.arrayBuffer());if(bytes.length>maxBytes-total)throw new Error('200 MiB cap reached');if(!bytes.subarray(0,5).equals(Buffer.from('%PDF-')))throw new Error('Source is not a PDF');await writeFile(destination,bytes);total+=bytes.length;}
   const digest=sha(bytes);if(hashes.has(digest))throw new Error('Duplicate original PDF inside group');hashes.add(digest);
   records.push({...source,title:`${source.courseTitle} — ${source.path}`,sha256:digest,bytes:bytes.length,license:'CC BY-NC-SA 4.0 (except individually marked third-party content)',license_url:'https://ocw.mit.edu/pages/privacy-and-terms-of-use/'});
  }
  await json(join(root,course.group,'manifest.json'),records);
 }
 console.log(JSON.stringify({action:'downloaded',bytes:total,capBytes:maxBytes}));
}
if(process.argv.includes('--extract')){
 const code=`import json,hashlib,sys,pathlib\nfrom pypdf import PdfReader\nroot=pathlib.Path(sys.argv[1])\nfor group in ['ml6867','algorithms6046','systems6004']:\n manifest=json.loads((root/group/'manifest.json').read_text(encoding='utf-8'))\n for item in manifest:\n  original=root/group/item['path']; data=original.read_bytes()\n  if hashlib.sha256(data).hexdigest()!=item['sha256']: raise ValueError('Original PDF hash changed')\n  reader=PdfReader(original); pages=[{'page':i+1,'text':page.extract_text() or ''} for i,page in enumerate(reader.pages)]\n  item['page_count']=len(pages)\n  (original.with_suffix(original.suffix+'.reference.json')).write_text(json.dumps({'path':item['path'],'original_sha256':item['sha256'],'source_url':item['source_url'],'extractor':'pypdf native original; no retrieval or AI','pages':pages},ensure_ascii=False,indent=2)+'\\n',encoding='utf-8')\n (root/group/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\\n',encoding='utf-8')\n print(json.dumps({'group':group,'documents':len(manifest),'pages':sum(item['page_count'] for item in manifest)}))\n`;
 const result=spawnSync(python,['-c',code,root],{encoding:'utf8',maxBuffer:1024*1024});if(result.error)throw result.error;process.stdout.write(result.stdout);if(result.status!==0)throw new Error(result.stderr);
}
if(process.argv.includes('--freeze')||process.argv.includes('--validate')){
 const summaries=[];let originals=0,bytes=0;
 for(const course of courses){
  const dir=join(root,course.group),manifest=JSON.parse(await readFile(join(dir,'manifest.json'),'utf8'));
  const pages=manifest.reduce((n,item)=>n+item.page_count,0);if(manifest.length<10||pages<150)throw new Error('Group lacks required document/page size');
  for(const item of manifest){
   const original=await readFile(join(dir,item.path));if(sha(original)!==item.sha256||original.length!==item.bytes)throw new Error('Original bytes changed');originals++;bytes+=original.length;
   const reference=JSON.parse(await readFile(join(dir,item.path+'.reference.json'),'utf8'));
   if(reference.original_sha256!==item.sha256||reference.source_url!==item.source_url||reference.pages.length!==item.page_count||reference.pages.some((page,index)=>page.page!==index+1))throw new Error('Original reference provenance/page manifest mismatch');
  }
  if(bytes>maxBytes)throw new Error('Corpus cap exceeded');
  const drafts=JSON.parse(await readFile(join(dir,'question-drafts.json'),'utf8'));if(drafts.length!==50||new Set(drafts.map(row=>row.query)).size!==50||new Set(drafts.map(row=>row.path)).size<10)throw new Error('Need 50 distinct queries covering at least ten documents');
  const questions=[];
  for(const [index,draft] of drafts.entries()){
   if(draft.query.length<35||/\.pdf\b|\bpage\s+\d/iu.test(draft.query)||draft.anchor.length<10)throw new Error('Invalid natural question/anchor');
   const item=manifest.find(item=>item.path===draft.path);if(!item||!Number.isInteger(draft.page)||draft.page<1||draft.page>item.page_count)throw new Error('Invalid original page identity');
   const original=JSON.parse(await readFile(join(dir,item.path+'.reference.json'),'utf8'));
   const page=original.pages.find(page=>page.page===draft.page);const start=page.text.indexOf(draft.anchor);if(start<0)throw new Error(`Original literal anchor absent: ${course.group} question ${index+1}`);
   const excerpt=page.text.slice(Math.max(0,start-80),Math.min(page.text.length,start+Math.max(draft.anchor.length+80,700)));
   if(excerpt.length>1000)throw new Error('Oversized evidence excerpt');
   questions.push({id:`${course.group}-${String(index+1).padStart(2,'0')}`,group:course.group,query:draft.query,expected:[{path:item.path,pages:[draft.page]}],reference:{path:item.path,page:draft.page,anchor:draft.anchor,excerpt,sourceUrl:item.source_url,sha256:sha(excerpt)}});
  }
  const serialized=JSON.stringify({questions},null,2)+'\n',destination=join(dir,'questions.json');
  if(process.argv.includes('--freeze')){try{const prior=await readFile(destination,'utf8');if(prior!==serialized)throw new Error('Frozen gold exists and differs; refusing overwrite');}catch(error){if(error.code!=='ENOENT')throw error;await writeFile(destination,serialized,{flag:'wx'});}}
  else if(await readFile(destination,'utf8')!==serialized)throw new Error('Frozen gold mismatch');
  summaries.push({group:course.group,documents:manifest.length,pages,questions:50,questionDocuments:new Set(drafts.map(row=>row.path)).size,manifestSha256:sha(await readFile(join(dir,'manifest.json'))),questionsSha256:sha(serialized)});
 }
 const freeze={mode:'independent original-PDF reference; no retrieval scores or paid AI',originals,bytes,groups:summaries};
 const freezeFile=join(root,'freeze.json'),serialized=JSON.stringify(freeze,null,2)+'\n';
 if(process.argv.includes('--freeze')){try{if(await readFile(freezeFile,'utf8')!==serialized)throw new Error('Freeze metadata differs');}catch(error){if(error.code!=='ENOENT')throw error;await writeFile(freezeFile,serialized,{flag:'wx'});}}
 else if(await readFile(freezeFile,'utf8')!==serialized)throw new Error('Freeze metadata changed');
 console.log(JSON.stringify({...freeze,freezeSha256:sha(serialized)}));
}
