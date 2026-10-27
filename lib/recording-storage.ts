import {S3Client,GetObjectCommand,HeadObjectCommand} from '@aws-sdk/client-s3';
import {getSignedUrl} from '@aws-sdk/s3-request-presigner';
import {readFileSync} from 'node:fs';
import type {RecordingObject} from './recording-catalog.ts';

export function recordingTargetConfig(){
 const endpoint=process.env.RECORDINGS_S3_ENDPOINT,bucket=process.env.RECORDINGS_S3_BUCKET;
 if(!endpoint||!bucket)throw new Error('录像播放器尚未配置私有存储访问');
 let parsed:URL;try{parsed=new URL(endpoint);}catch{throw new Error('录像存储地址配置无效');}
 if(parsed.protocol!=='https:'||!(/^[a-f0-9]{32}\.r2\.cloudflarestorage\.com$/i.test(parsed.hostname))||
  parsed.username||parsed.password||parsed.search||parsed.hash||parsed.port||!['','/'].includes(parsed.pathname))
  throw new Error('录像存储地址配置无效');
 return {bucket,endpointHost:parsed.hostname,endpoint:parsed.origin};
}

export function recordingStorageConfig(){
 const target=recordingTargetConfig();
 const file=process.env.RECORDINGS_S3_CREDENTIALS_FILE;
 if(file){
  try{
   // Re-read the atomically replaced file for each request, without container restarts.
   const value=JSON.parse(readFileSync(file,'utf8')) as Record<string,unknown>;
   if(!value||!['accessKeyId','secretAccessKey','sessionToken'].every(key=>typeof value[key]==='string'&&value[key].trim())||
    typeof value.expiresAt!=='string'||!/(?:Z|[+-]\d{2}:\d{2})$/.test(value.expiresAt))throw new Error();
   const expiration=new Date(value.expiresAt);
   if(!Number.isFinite(expiration.getTime())||expiration.getTime()<=Date.now()+60000)throw new Error();
   return {...target,credentials:{accessKeyId:value.accessKeyId as string,secretAccessKey:value.secretAccessKey as string,
    sessionToken:value.sessionToken as string,expiration}};
  }catch{throw new Error('录像临时只读凭据不可用或即将过期，请刷新后重试');}
 }
 const accessKeyId=process.env.RECORDINGS_S3_ACCESS_KEY_ID,secretAccessKey=process.env.RECORDINGS_S3_SECRET_ACCESS_KEY;
 const sessionToken=process.env.RECORDINGS_S3_SESSION_TOKEN;
 if(!accessKeyId||!secretAccessKey)throw new Error('录像播放器尚未配置私有存储访问');
 return {...target,credentials:{accessKeyId,secretAccessKey,...(sessionToken?{sessionToken}:{})}};
}

export function recordingPlaybackTtl(durationSeconds:number|null,expiration?:Date,now=Date.now()){
 const desired=Math.min(21600,Math.max(3600,Math.ceil(durationSeconds??0)+1800));
 const seconds=expiration?Math.min(desired,Math.floor((expiration.getTime()-now)/1000)-60):desired;
 if(!Number.isFinite(seconds)||seconds<1)throw new Error('录像临时只读凭据即将过期，请刷新后重试');
 return seconds;
}

export async function recordingPlaybackUrl(object:RecordingObject){
 const config=recordingStorageConfig();
 const client=new S3Client({region:'auto',endpoint:config.endpoint,forcePathStyle:true,credentials:config.credentials,
  maxAttempts:1,requestHandler:{requestTimeout:15000,connectionTimeout:5000}});
 try{
  const head=await client.send(new HeadObjectCommand({Bucket:config.bucket,Key:object.key}));
  if(head.ContentLength!==object.bytes||head.ETag!==object.etag)throw new Error('录像对象已变化，请更新归档后重试');
  // HEAD may consume time; cap the grant again immediately before signing.
  const expiresIn=recordingPlaybackTtl(object.durationSeconds,'expiration' in config.credentials?config.credentials.expiration:undefined);
  return await getSignedUrl(client,new GetObjectCommand({Bucket:config.bucket,Key:object.key,
   ResponseContentType:object.mime,ResponseContentDisposition:'inline',ResponseCacheControl:'private, no-store'}),{expiresIn});
 }finally{client.destroy();}
}
