import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {serviceValue} from './service-vault.ts';
import {versionStatus,type PublishedRelease} from './release-version.ts';
import packageInfo from '../package.json';
export async function checkDeploymentUpdate(){
  const repo=serviceValue('GITHUB_REPOSITORY'),token=serviceValue('GITHUB_ACTIONS_TOKEN');
  if(!/^[\w.-]+\/[\w.-]+$/.test(repo)||!token)throw new Error('请先配置 GitHub 私有仓库和令牌');
  const items:PublishedRelease[]=[];
  const signal=AbortSignal.timeout(20000);
  for(let page=1;page<=20;page++){
    const response=await fetch(`https://api.github.com/repos/${repo}/releases?per_page=100&page=${page}`,{
      headers:{Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'},signal,cache:'no-store'});
    if(!response.ok)throw new Error('版本检查失败，请检查 GitHub 读取权限、限额和网络');
    const batch=await response.json() as PublishedRelease[];items.push(...batch);
    if(batch.length<100)return {...versionStatus(packageInfo.version,items),checkedAt:new Date().toISOString()};
  }
  throw new Error('发布记录过多，无法完整检查版本');
}
export async function deploymentState(){let deployment=null;try{deployment=JSON.parse(await readFile(resolve(process.env.DEPLOY_STATUS_DIR||'/app/deploy-status','current.json'),'utf8'));}catch{}return {releaseVersion:packageInfo.version,version:process.env.APP_VERSION||'local-development',deployment,repository:serviceValue('GITHUB_REPOSITORY'),configured:Boolean(serviceValue('GITHUB_ACTIONS_TOKEN')&&serviceValue('GITHUB_REPOSITORY'))};}
export async function retryDeployment(tag:string){if(!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/.test(tag))throw new Error('版本标签无效');const repo=serviceValue('GITHUB_REPOSITORY');if(!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repo)||!serviceValue('GITHUB_ACTIONS_TOKEN'))throw new Error('请配置仓库和限定权限的 Actions 令牌');const headers={Authorization:`Bearer ${serviceValue('GITHUB_ACTIONS_TOKEN')}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','Content-Type':'application/json'};const r=await fetch(`https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`,{headers,signal:AbortSignal.timeout(15000)});if(!r.ok)throw new Error('未找到已发布版本');const release=await r.json();if(release.draft||release.prerelease)throw new Error('只允许正式发布版本');const trigger=await fetch(`https://api.github.com/repos/${repo}/actions/workflows/release.yml/dispatches`,{method:'POST',headers,body:JSON.stringify({ref:'main',inputs:{release_tag:tag}}),signal:AbortSignal.timeout(15000)});if(!trigger.ok)throw new Error('GitHub 未接受部署请求，请检查权限');return {ok:true};}
