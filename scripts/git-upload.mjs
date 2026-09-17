import {args,run,repository,privateRepository,requireMain,scanIndex} from './release-common.mjs';
try {
  const options=args(); requireMain();
  const repo=repository();privateRepository(repo);scanIndex();
  console.log(`目标私有仓库：${repo}\n暂存改动：\n${run('git',['diff','--cached','--stat']) || '无'}\n不会执行 git add，也不会上传未暂存的文件。`);
  if(!options.apply)console.log('仅预览。确认暂存清单后添加 --apply；需要提交时提供 --message "说明"。');
  else {
    if(run('git',['diff','--cached','--name-only'])) {
      if(!options.message)throw new Error('有暂存改动，请提供 --message');
      run('git',['commit','-m',options.message]);
    }
    run('git',['push','--set-upstream','origin','refs/heads/main:refs/heads/main']);
    console.log('main 上传成功。普通提交不会部署生产。');
  }
} catch(error){console.error(error.message);process.exitCode=1;}
