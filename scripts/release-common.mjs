import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
export const root = fileURLToPath(new URL('../',import.meta.url));
export function run(command,args) {
  try {return execFileSync(command,args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe'],maxBuffer:32*1024*1024}).trim();}
  catch {throw new Error(`${command} ${args[0] || ''} 失败，请检查工具安装、登录、权限和网络（不输出可能含凭据的错误）。`);}
}
export function args() {
  const values={};
  for(let i=2;i<process.argv.length;i++) {
    const key=process.argv[i];
    if(!['--apply','--repo','--message','--current','--latest'].includes(key)) throw new Error(`未知参数 ${key}`);
    if(key==='--apply') values.apply=true;
    else {const value=process.argv[++i];if(!value || value.startsWith('--'))throw new Error(`${key} 缺少值`);values[key.slice(2)]=value;}
  }
  return values;
}
export function repository(explicit) {
  if(explicit) {if(!/^[\w.-]+\/[\w.-]+$/.test(explicit))throw new Error('仓库格式为 owner/repo');return explicit;}
  const url=run('git',['remote','get-url','origin']);
  if(run('git',['remote','get-url','--push','origin'])!==url)throw new Error('origin 的读取与推送地址不一致，请先核对，避免上传到错误仓库');
  const match=/^(?:https:\/\/github\.com\/|git@github\.com:)([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(url);
  if(!match)throw new Error('origin 必须是 github.com 的 HTTPS 或 SSH 地址，不能在地址中放令牌');
  return match[1];
}
export function privateRepository(repo) {
  const info=JSON.parse(run('gh',['api',`repos/${repo}`]));
  if(!info.private)throw new Error('保护私人项目：只允许上传或发布到私有仓库');
}
export function releases(repo) {
  const pages=JSON.parse(run('gh',['api',`repos/${repo}/releases?per_page=100`,'--paginate','--slurp']));
  return pages.flat();
}
export function packageVersion() {return JSON.parse(readFileSync(resolve(root,'package.json'),'utf8')).version;}
export function requireMain() {if(run('git',['branch','--show-current'])!=='main')throw new Error('请先切换到 main 分支');}
const forbidden=/(^|\/)(?:\.env[^/]*|data|backups?|browser-profile|node_modules|\.next|\.codex|\.agents)(\/|$)|\.(?:db|sqlite3?|pem|key|p12|pfx|jpe?g|pdf|docx?|zip|7z|tar|gz)$/i;
const secret=/(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{30,}|\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}|\bGOCSPX-[A-Za-z0-9_-]{20,})/;
export function scanIndex() {
  const files=run('git',['ls-files','-z']).split('\0').filter(Boolean);
  for(const file of files) {
    if(forbidden.test(file))throw new Error(`禁止上传的文件：${file}。请从暂存区/跟踪中移除，保留本地原件。`);
    const content=run('git',['show',`:${file}`]);
    if(secret.test(content))throw new Error(`疑似密钥：${file}。已阻止上传，不显示密钥内容。`);
  }
  // Previously committed private files remain in Git history even after deletion.
  const history=run('git',['log','--all','--format=','--name-only']).split('\n').filter(Boolean);
  if(history.some(file=>forbidden.test(file)))throw new Error('Git 历史包含可能的私人文件；请先人工审核/清理历史，脚本不会自动改写历史');
  if(secret.test(run('git',['log','main','--format=','-p'])))throw new Error('main 历史差异中发现疑似密钥，请人工审核后再上传');
}
