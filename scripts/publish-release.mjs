import {args,run,repository,privateRepository,requireMain,scanIndex,releases,packageVersion} from './release-common.mjs';
import {parseVersion,compareVersions} from '../lib/release-version.ts';
try {
  const options=args();requireMain();
  if(run('git',['status','--porcelain']))throw new Error('发布前工作区必须干净：请先审核并上传全部代码改动');
  const repo=repository();privateRepository(repo);scanIndex();
  const version=packageVersion(),tag=`v${version}`;
  if(!parseVersion(version))throw new Error('package.json 必须使用稳定版本 X.Y.Z');
  const sha=run('git',['rev-parse','HEAD']);
  const remote=run('git',['ls-remote','origin','refs/heads/main']).split(/\s/)[0];
  if(sha!==remote)throw new Error('本地 HEAD 与远程 main 不一致，请先上传/同步');
  const existing=releases(repo);
  if(existing.some(r=>r.tag_name===tag))throw new Error('该 Release 已存在，禁止覆盖');
  if(existing.some(r=>!r.draft&&!r.prerelease&&parseVersion(r.tag_name)&&compareVersions(r.tag_name,version)>=0))throw new Error('版本号必须高于所有现有正式版本');
  if(run('git',['ls-remote','origin',`refs/tags/${tag}`]))throw new Error('远程标签已存在，请人工核查，脚本不覆盖标签');
  console.log(`即将发布 ${repo} ${tag}\n提交：${sha}\n正式 Release 将触发生产部署。`);
  if(!options.apply)console.log('仅预览。确认服务器准备完成后使用 --apply。');
  else {
    run('gh',['release','create',tag,'--repo',repo,'--target',sha,'--title',tag,'--generate-notes','--prerelease=false']);
    console.log('正式 Release 已发布。请检查 GitHub Actions；发布成功不代表部署已成功。');
  }
}catch(error){console.error(error.message);process.exitCode=1;}
