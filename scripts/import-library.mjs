// Explicit-directory, read-only importer for existing QuercusModuleDownloader/files.
import {readdir,readFile,lstat,realpath} from 'node:fs/promises';
import {resolve,relative,basename,extname,parse} from 'node:path';
const args=process.argv.slice(2),arg=k=>args[args.indexOf(k)+1];
if(!args.includes('--dir')||!args.includes('--course'))throw new Error('Usage: npm run import:library -- --dir <explicit course folder> --course <Canvas course ID> [--url https://your-site]');
const root=await realpath(resolve(arg('--dir'))),course=arg('--course'),url=new URL(args.includes('--url')?arg('--url'):'http://localhost:3000');
if(root===parse(root).root||root===process.env.USERPROFILE||root===process.env.HOME)throw new Error('Select a course folder, not a home or filesystem root');
if(url.protocol!=='https:'&&!['localhost','127.0.0.1'].includes(url.hostname))throw new Error('Remote upload requires HTTPS');
const blocked=new Set(['.git','.env','.venv','node_modules','browser-profile','debug','__pycache__','data','private','appdata']);
if(root.split(/[\\/]/).some(p=>blocked.has(p.toLowerCase())||p.startsWith('.')))throw new Error('Private, system and browser directories cannot be imported');
let imported=0,skipped=0;
async function walk(dir){for(const e of await readdir(dir,{withFileTypes:true})){if(e.name.startsWith('.')||blocked.has(e.name.toLowerCase()))continue;const path=resolve(dir,e.name);const stat=await lstat(path);if(stat.isSymbolicLink())continue;const canonical=await realpath(path);if(relative(root,canonical).startsWith('..'))continue;if(stat.isDirectory()){await walk(path);continue;}if(!['.pdf','.doc','.docx','.txt','.md','.png','.jpg','.jpeg','.webp'].includes(extname(e.name).toLowerCase())||stat.size>50*1024*1024){skipped++;continue;}const form=new FormData();form.set('file',new Blob([await readFile(path)]),basename(path));form.set('courseId',course);form.set('originKey',course+'/'+relative(root,path).replaceAll('\\','/'));const r=await fetch(new URL('/api/library',url),{method:'POST',headers:{Origin:url.origin,...(process.env.DASHBOARD_API_TOKEN?{Authorization:`Bearer ${process.env.DASHBOARD_API_TOKEN}`}:{})},body:form});if(!r.ok)throw new Error(`Upload failed (${r.status}); no credentials or response body printed`);imported++;}}
await walk(root);console.log(JSON.stringify({imported,skipped}));
