import {args,repository,releases,packageVersion} from './release-common.mjs';
import {versionStatus,parseVersion} from '../lib/release-version.ts';
try {
  const options=args(), current=options.current || packageVersion();
  const items=options.latest ? [{tag_name:options.latest,draft:false,prerelease:false}] : releases(repository(options.repo));
  if(options.latest && !parseVersion(options.latest))throw new Error('目标版本无效');
  console.log(JSON.stringify(versionStatus(current,items),null,2));
}catch(error){console.error(JSON.stringify({status:'error',updateAvailable:null,error:error.message}));process.exitCode=1;}
